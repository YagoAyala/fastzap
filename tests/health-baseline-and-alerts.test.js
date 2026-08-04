/**
 * Guards das três cegueiras operacionais achadas na auditoria de 27/07→03/08/2026:
 *
 * 1) BASELINE VOLÁTIL. O vigia de shadowban só alerta se a faixa de hora
 *    costumava ter tráfego, e "costumava" exige 3 dias observados. Esse
 *    histórico vivia em memória: o container subiu 31/07 15:19Z e atravessou
 *    toda a janela pós-migração sem baseline, e todo deploy zerava de novo.
 *
 * 2) NENHUM ALERTA COBRIA O GATEWAY. 19 desconexões em 3 dias, 8 webhooks
 *    perdidos e 5 envios recusados por cap — nada disso gerou um único aviso.
 *    A auditoria só achou porque foi ler `docker logs` por SSH.
 *
 * 3) /health FALSO-VERDE NO PIOR ESTADO. Perda terminal de sessão remove o
 *    cliente do mapa; a regra antiga ("sem sessão = saudável") devolvia 200
 *    exatamente quando o gateway estava mudo.
 *
 * Rode com: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.API_TOKEN ??= "test-token";
process.env.QR_ACCESS_TOKEN ??= "test-qr-token";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";

const { SessionHealth } = await import(
  "../src/infrastructure/whatsapp/SessionHealth.js"
);
const { GatewayAlerts } = await import(
  "../src/infrastructure/notifications/GatewayAlerts.js"
);
const { buildServer } = await import("../src/infrastructure/http/server.js");

const fakeStore = (snapshot = null) => {
  const persisted = [];
  return {
    persisted,
    load: async () => snapshot,
    persist: async (payload) => persisted.push(payload),
    prune: async () => {},
  };
};

const isoDay = (offsetDays) =>
  new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("vigia de shadowban: a baseline sobrevive ao restart", () => {
  test("load() reidrata o histórico e o vigia já alerta no primeiro minuto", async () => {
    const hour = new Date().getUTCHours();
    const notified = [];
    const health = new SessionHealth({
      notifier: { notify: async (msg) => notified.push(msg) },
      silenceAlertMs: 1000,
      store: fakeStore({
        // Silêncio começou há muito tempo — é o que o restart perdia.
        lastInboundAt: Date.now() - 3 * 60 * 60 * 1000,
        lastOutboundAt: null,
        alertedAt: null,
        hours: [
          { hour, day: isoDay(1), count: 12 },
          { hour, day: isoDay(2), count: 9 },
          { hour, day: isoDay(3), count: 14 },
        ],
      }),
    });

    await health.load();

    const result = health.check();

    assert.equal(
      result.alerted,
      true,
      "com baseline persistida o vigia enxerga na hora; em memória levaria 3 dias no ar",
    );
    assert.equal(notified.length, 1);
    health.stop();
  });

  test("sem histórico persistido o vigia continua calado (não inventa baseline)", async () => {
    const health = new SessionHealth({
      silenceAlertMs: 1000,
      store: fakeStore(null),
    });

    await health.load();

    assert.equal(health.check().reason, "sem_baseline");
    health.stop();
  });

  test("uma hora com menos de 3 dias observados não alerta", async () => {
    const hour = new Date().getUTCHours();
    const health = new SessionHealth({
      silenceAlertMs: 1000,
      store: fakeStore({
        lastInboundAt: Date.now() - 3 * 60 * 60 * 1000,
        hours: [
          { hour, day: isoDay(1), count: 5 },
          { hour, day: isoDay(2), count: 5 },
        ],
      }),
    });

    await health.load();

    assert.equal(
      health.check().reason,
      "hora_normalmente_parada",
      "silêncio em hora sem histórico é normal — alarme falso mata a confiança no alarme",
    );
    health.stop();
  });

  test("o cooldown do alerta também é persistido", async () => {
    const hour = new Date().getUTCHours();
    const notified = [];
    const health = new SessionHealth({
      notifier: { notify: async (m) => notified.push(m) },
      silenceAlertMs: 1000,
      alertCooldownMs: 60 * 60 * 1000,
      store: fakeStore({
        lastInboundAt: Date.now() - 3 * 60 * 60 * 1000,
        alertedAt: Date.now() - 60_000,
        hours: [
          { hour, day: isoDay(1), count: 3 },
          { hour, day: isoDay(2), count: 3 },
          { hour, day: isoDay(3), count: 3 },
        ],
      }),
    });

    await health.load();
    const result = health.check();

    assert.equal(result.alreadyAlerted, true);
    assert.equal(
      notified.length,
      0,
      "sem cooldown persistido, um crash-loop repetiria o mesmo alerta a cada 5 min",
    );
    health.stop();
  });

  test("tráfego observado é gravado (hora/dia + último inbound)", async () => {
    const store = fakeStore(null);
    const health = new SessionHealth({ store, flushDelayMs: 5 });

    await health.load();
    health.recordInbound();
    await health.flush();

    assert.equal(store.persisted.length, 1);
    const [payload] = store.persisted;
    assert.ok(payload.lastInboundAt, "o relógio do silêncio precisa persistir");
    assert.equal(payload.hours.length, 1);
    assert.equal(payload.hours[0].hour, new Date().getUTCHours());
    assert.equal(payload.hours[0].count, 1);
    health.stop();
  });
});

describe("alertas do gateway", () => {
  const clock = () => {
    const state = { t: 0 };
    return state;
  };

  test("QR pedido dispara alerta crítico — é o número caindo", () => {
    const notified = [];
    const t = clock();
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      now: () => t.t,
    });

    alerts.qrRequested("focca");

    assert.equal(notified.length, 1);
    assert.match(notified[0], /QR/);
  });

  test("cooldown impede o mesmo alerta de virar ruído", () => {
    const notified = [];
    const t = clock();
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      cooldownMs: 1000,
      now: () => t.t,
    });

    alerts.qrRequested("focca");
    t.t = 500;
    alerts.qrRequested("focca");
    assert.equal(notified.length, 1, "repetição dentro da janela é suprimida");

    t.t = 2000;
    alerts.qrRequested("focca");
    assert.equal(notified.length, 2, "passada a janela, volta a avisar");
  });

  test("sessão perdida avisa sempre — não existe reconexão pra loggedOut", () => {
    const notified = [];
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
    });

    alerts.sessionLost("focca", "loggedOut");

    assert.equal(notified.length, 1);
    assert.match(notified[0], /loggedOut/);
  });

  test("queda isolada não alerta; série de quedas alerta", () => {
    const notified = [];
    const t = clock();
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      disconnectThreshold: 3,
      now: () => t.t,
    });

    alerts.recordDisconnect("focca", "connectionClosed");
    alerts.recordDisconnect("focca", "connectionClosed");
    assert.equal(notified.length, 0, "duas quedas é rede, não incidente");

    alerts.recordDisconnect("focca", "connectionClosed");
    assert.equal(notified.length, 1);
    assert.match(notified[0], /reconectando demais/i);
  });

  test("quedas antigas saem da janela", () => {
    const notified = [];
    const t = clock();
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      disconnectThreshold: 3,
      windowMs: 1000,
      now: () => t.t,
    });

    alerts.recordDisconnect("focca", "x");
    alerts.recordDisconnect("focca", "x");
    t.t = 2000;
    alerts.recordDisconnect("focca", "x");

    assert.equal(notified.length, 0);
  });

  test("taxa de erro de envio exige volume E proporção", () => {
    const notified = [];
    const t = clock();
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      sendFailureThreshold: 3,
      sendFailureRate: 0.5,
      now: () => t.t,
    });

    alerts.recordSendResult({ ok: false, error: "cap" });
    alerts.recordSendResult({ ok: false, error: "cap" });
    assert.equal(notified.length, 0, "2 falhas ainda é amostra pequena");

    alerts.recordSendResult({ ok: false, error: "cap" });
    assert.equal(notified.length, 1);
    assert.match(notified[0], /Envios falhando/);
  });

  test("uma entrega sem recibo não alerta; uma série alerta", () => {
    const notified = [];
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      undeliveredThreshold: 3,
    });

    const one = { messageId: "x", jid: "5511@s.whatsapp.net", ageMs: 900_000 };
    alerts.undelivered(one);
    alerts.undelivered(one);
    assert.equal(
      notified.length,
      0,
      "aparelho desligado produz o mesmo silêncio de entrega morta — uma só não é incidente",
    );

    alerts.undelivered(one);
    assert.equal(notified.length, 1);
    assert.match(notified[0], /sem confirmação de entrega/i);
  });

  test("falhas diluídas em muito volume não alertam", () => {
    const notified = [];
    const alerts = new GatewayAlerts({
      notifier: { notify: async (m) => notified.push(m) },
      sendFailureThreshold: 3,
      sendFailureRate: 0.5,
    });

    for (let i = 0; i < 50; i += 1) alerts.recordSendResult({ ok: true });
    alerts.recordSendResult({ ok: false, error: "x" });
    alerts.recordSendResult({ ok: false, error: "x" });
    alerts.recordSendResult({ ok: false, error: "x" });

    assert.equal(notified.length, 0, "3 falhas em 53 envios não é incidente");
  });
});

describe("/health reflete a SESSÃO, não o processo", () => {
  const serverWith = (sessionManager) =>
    buildServer({
      sessionManager,
      sessionRepository: {},
      chatRepository: {},
      messageRepository: {},
    });

  const managerStub = ({ ids = [], connected = [], expected = [] }) => ({
    listIds: () => ids,
    isConnected: (id) => connected.includes(id),
    expectedSessionIds: () => expected,
    healthSnapshot: () => null,
    getClient: () => null,
  });

  test("sessão pareada que sumiu do gateway devolve 503", async () => {
    const app = serverWith(
      managerStub({ ids: [], connected: [], expected: ["focca"] }),
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(
      res.statusCode,
      503,
      "cliente removido do mapa por perda terminal era exatamente o estado que devolvia 200",
    );
    const body = res.json();
    assert.equal(body.data.expectedSessions, 1);
    assert.equal(body.data.connectedSessions, 0);
    await app.close();
  });

  test("sessão presente mas desconectada devolve 503", async () => {
    const app = serverWith(
      managerStub({ ids: ["focca"], connected: [], expected: ["focca"] }),
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(res.statusCode, 503);
    await app.close();
  });

  test("sessão conectada devolve 200", async () => {
    const app = serverWith(
      managerStub({
        ids: ["focca"],
        connected: ["focca"],
        expected: ["focca"],
      }),
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.connectedSessions, 1);
    await app.close();
  });

  test("instalação nova, sem sessão nenhuma pareada, continua 200", async () => {
    const app = serverWith(managerStub({}));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(
      res.statusCode,
      200,
      "gateway recém-instalado ainda não tem número — não é falha",
    );
    await app.close();
  });

  test("/health continua público (o monitor não manda token)", async () => {
    const app = serverWith(
      managerStub({ ids: ["focca"], connected: ["focca"], expected: ["focca"] }),
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    assert.notEqual(res.statusCode, 401);
    await app.close();
  });
});

describe("guard estrutural: o alerta continua ligado no boot", () => {
  // Os alertas não têm efeito observável em teste unitário do main — o que
  // quebra na prática é alguém mexer no bootstrap e desconectar um listener sem
  // perceber, e aí o gateway volta a ser mudo exatamente como era antes.
  const source = readFileSync(join(root, "src/main.js"), "utf8");

  const WIRING = [
    ["onQr", "QR pedido = pareamento perdido, o alerta mais crítico do gateway"],
    ["onConnectionChange", "quedas em série (19 em 3 dias passaram em branco)"],
    ["onSendResult", "taxa de erro de envio"],
    ["onMessageStatus", "entrega não confirmada (undelivered)"],
    ["onDisconnect", "perda terminal de sessão"],
  ];

  for (const [hook, why] of WIRING) {
    test(`main.js liga ${hook} (${why})`, () => {
      assert.match(source, new RegExp(`sessionManager\\.${hook}\\(`));
    });
  }

  test("a baseline do vigia é aguardada no boot e descarregada no shutdown", () => {
    assert.match(
      source,
      /await sessionManager\.startHealthWatch\(/,
      "sem await, o vigia começa a checar antes de reidratar e se declara sem_baseline",
    );
    assert.match(
      source,
      /flushHealth\(\)/,
      "write-behind sem flush no SIGTERM perde justamente as observações mais recentes",
    );
  });

  test("o compose exporta log para fora da VM", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

    assert.match(
      compose,
      /logging:/,
      "sem driver de log configurável, todo log do gateway morre dentro da VM e só existe via SSH",
    );
    assert.match(compose, /DOCKER_LOG_DRIVER/);
  });
});
