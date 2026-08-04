/**
 * Guards do contrato de STATUS de saída — as duas cegueiras que a auditoria de
 * produção de 27/07→03/08/2026 encontrou:
 *
 * 1) RECIBO DE MENSAGEM QUE NÃO É NOSSA vazava como recibo de saída. Quem
 *    consome grava MessageStatusCallback como `direction='outgoing'`, então o
 *    `read` que o próprio gateway gera ao marcar o INBOUND como lido virava uma
 *    linha de saída carregando o wamid de ENTRADA (17 linhas assim no banco da
 *    Focca em 4 dias). Foi esse par de linhas que a auditoria leu como "o
 *    outbound é logado com o id do inbound".
 *
 * 2) ENTREGA MORTA E SILENCIOSA. O Baileys avisa quando entrega (`delivered`) e
 *    quando o servidor recusa (status ERROR → `failed`). O terceiro desfecho não
 *    gera evento nenhum: aceitou, deu wamid, e o recibo nunca chega. Medido no
 *    banco: 13 de 261 envios com +1h de vida (5%) nunca chegaram a
 *    delivered/read e ninguém foi avisado.
 *
 * Rode com: npm test
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

process.env.API_TOKEN ??= "test-token";
process.env.QR_ACCESS_TOKEN ??= "test-qr-token";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
process.env.WEBHOOK_URL = "http://localhost:9/webhook";

const { DeliveryTracker } = await import(
  "../src/infrastructure/whatsapp/DeliveryTracker.js"
);
const { WebhookDispatcher } = await import(
  "../src/infrastructure/webhook/WebhookDispatcher.js"
);
const axios = (await import("axios")).default;

const fakeSessionManager = () => {
  const listeners = { message: [], status: [] };
  return {
    listeners,
    onMessage: (fn) => listeners.message.push(fn),
    onMessageStatus: (fn) => listeners.status.push(fn),
    getClient: () => null,
    emitStatus: (status) => {
      for (const fn of listeners.status) fn(status, "focca");
    },
  };
};

const captureDispatch = () => {
  const sent = [];
  mock.method(axios, "post", async (_url, payload) => {
    sent.push(payload);
    return { status: 200, data: {} };
  });
  return sent;
};

describe("recibo de saída só existe para mensagem NOSSA", () => {
  test("status com fromMe=false não vira MessageStatusCallback", async () => {
    const sent = captureDispatch();
    const manager = fakeSessionManager();
    new WebhookDispatcher(manager);

    manager.emitStatus({
      messageId: "A5EEDCEBE915BF8B4428BA5D053800EC",
      jid: "5527999439676@s.whatsapp.net",
      fromMe: false,
      status: "read",
    });

    await new Promise((resolve) => setImmediate(resolve));
    mock.restoreAll();

    assert.deepEqual(
      sent,
      [],
      "recibo de mensagem recebida não pode virar recibo de saída: o consumidor " +
        "grava como direction='outgoing' e a linha fica com o wamid de entrada",
    );
  });

  test("status com fromMe=true é despachado no envelope que o consumidor entende", async () => {
    const sent = captureDispatch();
    const manager = fakeSessionManager();
    new WebhookDispatcher(manager);

    manager.emitStatus({
      messageId: "3EB0F62521613D1DED341D",
      jid: "5527999439676:12@s.whatsapp.net",
      fromMe: true,
      status: "delivered",
    });

    await new Promise((resolve) => setImmediate(resolve));
    mock.restoreAll();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "MessageStatusCallback");
    assert.equal(sent[0].messageId, "3EB0F62521613D1DED341D");
    assert.equal(sent[0].status, "delivered");
    assert.equal(
      sent[0].phone,
      "5527999439676",
      "o índice de aparelho (:12) e o domínio precisam sair — quem indexa por telefone não casa com eles",
    );
  });

  test("undelivered leva o motivo junto", async () => {
    const sent = captureDispatch();
    const manager = fakeSessionManager();
    new WebhookDispatcher(manager);

    manager.emitStatus({
      messageId: "3EB0AAA",
      jid: "5511999999999@s.whatsapp.net",
      fromMe: true,
      status: "undelivered",
      reason: "no_delivery_ack",
    });

    await new Promise((resolve) => setImmediate(resolve));
    mock.restoreAll();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, "undelivered");
    assert.equal(sent[0].reason, "no_delivery_ack");
  });
});

describe("DeliveryTracker: ausência de recibo vira evento", () => {
  const trackerAt = (clock, overrides = {}) =>
    new DeliveryTracker({
      ackTimeoutMs: 1000,
      now: () => clock.t,
      ...overrides,
    });

  test("envio sem recibo dentro do prazo é declarado undelivered", () => {
    const clock = { t: 0 };
    const emitted = [];
    const tracker = trackerAt(clock, { onUndelivered: (e) => emitted.push(e) });

    tracker.track("3EB0AAA", "5511999999999@s.whatsapp.net");
    clock.t = 999;
    assert.equal(tracker.sweep().length, 0, "não pode disparar antes do prazo");

    clock.t = 1001;
    const expired = tracker.sweep();

    assert.equal(expired.length, 1);
    assert.equal(expired[0].messageId, "3EB0AAA");
    assert.equal(emitted.length, 1);
    assert.equal(
      tracker.sweep().length,
      0,
      "não pode reemitir o mesmo id na varredura seguinte",
    );
  });

  test("recibo de entrega encerra a pendência", () => {
    const clock = { t: 0 };
    const emitted = [];
    const tracker = trackerAt(clock, { onUndelivered: (e) => emitted.push(e) });

    tracker.track("3EB0BBB", "5511999999999@s.whatsapp.net");
    assert.equal(tracker.settle("3EB0BBB", "delivered"), true);

    clock.t = 5000;
    assert.equal(tracker.sweep().length, 0);
    assert.equal(emitted.length, 0);
  });

  test("`sent` NÃO encerra: chegou ao servidor, não ao aparelho", () => {
    const clock = { t: 0 };
    const tracker = trackerAt(clock);

    tracker.track("3EB0CCC", "5511999999999@s.whatsapp.net");
    assert.equal(
      tracker.settle("3EB0CCC", "sent"),
      false,
      "'sent' é estado intermediário — tratá-lo como entrega é o falso-verde que este vigia existe pra matar",
    );

    clock.t = 5000;
    assert.equal(tracker.sweep().length, 1);
  });

  test("recusa explícita do servidor também encerra", () => {
    const clock = { t: 0 };
    const tracker = trackerAt(clock);
    tracker.track("3EB0DDD", "5511999999999@s.whatsapp.net");
    assert.equal(tracker.settle("3EB0DDD", "failed"), true);
  });

  test("grupo e reação ficam de fora", () => {
    assert.equal(
      DeliveryTracker.isTrackable("123456@g.us", { text: "oi" }),
      false,
      "grupo recebe recibo por participante em message-receipt.update, não em messages.update — rastrear daria 100% de falso undelivered",
    );
    assert.equal(
      DeliveryTracker.isTrackable("5511999999999@s.whatsapp.net", {
        react: { text: "⏳" },
      }),
      false,
    );
    assert.equal(
      DeliveryTracker.isTrackable("5511999999999@s.whatsapp.net", {
        text: "oi",
      }),
      true,
    );
  });

  test("o mapa de pendências tem teto", () => {
    const clock = { t: 0 };
    const tracker = trackerAt(clock, { maxPending: 2 });

    tracker.track("a", "j");
    tracker.track("b", "j");
    tracker.track("c", "j");

    assert.equal(tracker.stats().pending, 2);
    assert.equal(
      tracker.settle("a", "delivered"),
      false,
      "o mais antigo deve ter saído — diagnóstico não pode virar vazamento de memória",
    );
  });
});

describe("rótulo de status", () => {
  test("o proto 0 (ERROR) sai como 'failed', que é o que a sentinela conta", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");

    const source = readFileSync(
      join(root, "src/infrastructure/whatsapp/BaileysClient.js"),
      "utf8",
    );

    assert.match(
      source,
      /0:\s*'failed'/,
      "status 0 do proto precisa sair como 'failed': a sentinela de entrega faz WHERE status='failed' e ficaria zero pra sempre",
    );
    assert.match(
      source,
      /if\s*\(!fromMe\)\s*continue/,
      "o emissor precisa barrar recibo de mensagem que não é nossa antes de propagar",
    );
  });
});
