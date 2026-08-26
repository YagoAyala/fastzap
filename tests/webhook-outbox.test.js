import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.API_TOKEN ??= "test-token";
process.env.QR_ACCESS_TOKEN ??= "test-qr-token";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";

const { WebhookOutbox } = await import(
  "../src/infrastructure/webhook/WebhookOutbox.js"
);

const message = (phone, messageId, extra = {}) => ({
  instanceId: "focca",
  type: "ReceivedCallback",
  phone,
  messageId,
  fromMe: false,
  ...extra,
});

const receipt = (messageId) => ({
  instanceId: "focca",
  type: "MessageStatusCallback",
  phone: "111914298384448",
  messageId,
  status: "sent",
  fromMe: true,
});

const fakeStore = ({ failOn = null } = {}) => {
  const rows = new Map();
  let seq = 0;
  const guard = (op) => {
    if (failOn === op) throw new Error(`store indisponível: ${op}`);
  };
  return {
    rows,
    async enqueue(entry) {
      guard("enqueue");
      const id = ++seq;
      rows.set(id, { id, status: "pending", attempts: 0, ...entry });
      return id;
    },
    async markDelivered(id) {
      guard("markDelivered");
      const row = rows.get(id);
      if (row) row.status = "delivered";
    },
    async defer(id, { attempts, lastError, nextAttemptAt }) {
      guard("defer");
      const row = rows.get(id);
      if (row) Object.assign(row, { attempts, lastError, nextAttemptAt });
    },
    async markDead(id, { lastError }) {
      guard("markDead");
      const row = rows.get(id);
      if (row) Object.assign(row, { status: "dead", lastError });
    },
    async listPending() {
      guard("listPending");
      return [...rows.values()].filter((r) => r.status === "pending");
    },
    async pruneDelivered() {
      return 0;
    },
  };
};

const collectingAlerts = () => {
  const fired = [];
  return {
    fired,
    webhookRetryExhausted: (e) => fired.push(["retry_exhausted", e]),
    webhookDead: (e) => fired.push(["dead", e]),
    webhookBacklog: (e) => fired.push(["backlog", e]),
    webhookShed: (e) => fired.push(["shed", e]),
  };
};

const build = (opts = {}) =>
  new WebhookOutbox({
    concurrency: 4,
    maxAttempts: 3,
    retryDelayMs: 0,
    sleep: async () => {},
    ...opts,
  });

const TEMPESTADE_DE_26_08 = 473;

describe("cap de concorrência", () => {
  test("rajada de 473 recibos nunca passa do teto de POSTs em voo", async () => {
    let inflight = 0;
    let peak = 0;
    const outbox = build({
      concurrency: 4,
      transport: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setImmediate(r));
        inflight -= 1;
      },
    });

    for (let i = 0; i < TEMPESTADE_DE_26_08; i += 1) {
      outbox.enqueue(receipt(`3EB0${i}`));
    }
    await outbox.idle();

    assert.equal(
      peak,
      4,
      `pico de ${peak} POSTs em voo: em 26/08 isso abriu 352 sockets TLS numa e2-small ` +
        `e afogou o cliente HTTP do próprio gateway por 2 minutos`,
    );
    assert.equal(
      outbox.snapshot().delivered,
      TEMPESTADE_DE_26_08,
      "limitar concorrência não pode virar desculpa para perder evento",
    );
  });
});

describe("prioridade entre faixas", () => {
  test("mensagem de usuário fura fila de recibos já enfileirados", async () => {
    const order = [];
    const outbox = build({
      concurrency: 1,
      transport: async (payload) => {
        order.push(payload.messageId);
        await new Promise((r) => setImmediate(r));
      },
    });

    for (let i = 0; i < 50; i += 1) outbox.enqueue(receipt(`recibo-${i}`));
    outbox.enqueue(message("5547992512269", "COMPROVANTE"));
    await outbox.idle();

    const posicao = order.indexOf("COMPROVANTE");
    assert.ok(
      posicao <= 1,
      `comprovante entregue na posição ${posicao} de 51: com 473 recibos na frente, ` +
        `essa espera é exatamente o timeout de 10s que perdeu o PDF de R$ 858,66`,
    );
  });
});

describe("ordem por telefone", () => {
  test("duas mensagens do mesmo telefone saem na ordem de chegada", async () => {
    const order = [];
    const outbox = build({
      concurrency: 8,
      transport: async (payload) => {
        const atrasoMs = payload.messageId === "A" ? 20 : 0;
        await new Promise((r) => setTimeout(r, atrasoMs));
        order.push(payload.messageId);
      },
    });

    outbox.enqueue(message("5547992512269", "A"));
    outbox.enqueue(message("5547992512269", "B"));
    await outbox.idle();

    assert.deepEqual(
      order,
      ["A", "B"],
      "o debounce da Focca concatena as mensagens na ordem de chegada: inverter troca o sentido da frase",
    );
  });

  test("telefones diferentes seguem em paralelo", async () => {
    let inflight = 0;
    let peak = 0;
    const outbox = build({
      concurrency: 4,
      transport: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
      },
    });

    outbox.enqueue(message("5547992512269", "A"));
    outbox.enqueue(message("5566981363833", "B"));
    outbox.enqueue(message("5551985771063", "C"));
    await outbox.idle();

    assert.ok(peak >= 2, "serializar por telefone não pode virar fila global de um só");
  });
});

describe("durabilidade da mensagem de usuário", () => {
  test("payload é persistido antes da primeira tentativa, não depois da falha", async () => {
    const store = fakeStore();
    const outbox = build({
      store,
      transport: async () => {
        assert.equal(
          store.rows.size,
          1,
          "gravar só depois de falhar perde a mensagem se o container cair no meio da tentativa",
        );
      },
    });

    outbox.enqueue(message("5547992512269", "3A4FBBC4"));
    await outbox.idle();
  });

  test("tentativas esgotadas deixam a linha pendente em vez de descartar o payload", async () => {
    const store = fakeStore();
    const alerts = collectingAlerts();
    const outbox = build({
      store,
      alerts,
      transport: async () => {
        const err = new Error("timeout of 10000ms exceeded");
        err.code = "ECONNABORTED";
        throw err;
      },
    });

    outbox.enqueue(
      message("5566981363833", "3A4FBBC4DBF9F317CDA8", {
        document: { fileName: "Comprovante-98C28E6A.pdf", base64: "JVBERi0" },
      }),
    );
    await outbox.idle();

    const [row] = [...store.rows.values()];
    assert.equal(
      row.status,
      "pending",
      "em 26/08 três timeouts jogavam o payload fora: sem linha, sem replay, sem rastro",
    );
    assert.equal(row.attempts, 3);
    assert.equal(
      row.payload.document.fileName,
      "Comprovante-98C28E6A.pdf",
      "o payload inteiro precisa sobreviver, senão não há o que reentregar",
    );
    assert.ok(
      alerts.fired.some(([tipo]) => tipo === "retry_exhausted"),
      "foram 3 semanas de perda sem um único alerta",
    );
  });

  test("recover() reentrega o que ficou pendente de um container anterior", async () => {
    const store = fakeStore();
    await store.enqueue({
      lane: "message",
      phone: "5566981363833",
      messageId: "3A4FBBC4DBF9F317CDA8",
      payload: message("5566981363833", "3A4FBBC4DBF9F317CDA8"),
    });

    const entregues = [];
    const outbox = build({
      store,
      transport: async (payload) => entregues.push(payload.messageId),
    });

    const recuperadas = await outbox.recover();
    await outbox.idle();

    assert.equal(recuperadas, 1);
    assert.deepEqual(entregues, ["3A4FBBC4DBF9F317CDA8"]);
    assert.equal([...store.rows.values()][0].status, "delivered");
  });

  test("teto absoluto de tentativas marca dead e alerta, nunca some calado", async () => {
    const store = fakeStore();
    const alerts = collectingAlerts();
    const outbox = build({
      store,
      alerts,
      maxAttempts: 2,
      deadAfterAttempts: 2,
      transport: async () => {
        throw new Error("recusado");
      },
    });

    outbox.enqueue(message("5547992512269", "X"));
    await outbox.idle();

    assert.equal([...store.rows.values()][0].status, "dead");
    assert.ok(alerts.fired.some(([tipo]) => tipo === "dead"));
  });
});

describe("fail-open quando o banco some", () => {
  test("store quebrado na gravação ainda entrega a mensagem", async () => {
    const entregues = [];
    const outbox = build({
      store: fakeStore({ failOn: "enqueue" }),
      transport: async (payload) => entregues.push(payload.messageId),
    });

    outbox.enqueue(message("5547992512269", "SEM-BANCO"));
    await outbox.idle();

    assert.deepEqual(
      entregues,
      ["SEM-BANCO"],
      "perder durabilidade é ruim, parar de entregar é pior",
    );
  });

  test("sem store nenhum, a perda definitiva vira alerta", async () => {
    const alerts = collectingAlerts();
    const outbox = build({
      store: null,
      alerts,
      transport: async () => {
        throw new Error("morreu");
      },
    });

    outbox.enqueue(message("5547992512269", "Y"));
    await outbox.idle();

    assert.ok(
      alerts.fired.some(([tipo]) => tipo === "dead"),
      "sem banco a mensagem some de verdade, então tem que ser barulhento",
    );
  });
});

describe("recibo de entrega", () => {
  test("fila de recibo tem teto, e o descarte é contado e alertado", async () => {
    const alerts = collectingAlerts();
    let liberar;
    const travado = new Promise((r) => {
      liberar = r;
    });
    const outbox = build({
      concurrency: 1,
      receiptQueueCap: 10,
      alerts,
      transport: async () => travado,
    });

    for (let i = 0; i < 40; i += 1) outbox.enqueue(receipt(`r-${i}`));
    liberar();
    await outbox.idle();

    assert.ok(
      outbox.snapshot().shed > 0,
      "sem teto a fila cresce até o container morrer de memória",
    );
    assert.ok(
      alerts.fired.some(([tipo]) => tipo === "shed"),
      "recibo perdido cega a sentinela de entrega: ela conta status='failed' e lê verde por ausência de dado",
    );
  });

  test("recibo com tentativas esgotadas não ocupa o banco", async () => {
    const store = fakeStore();
    const outbox = build({
      store,
      transport: async () => {
        throw new Error("timeout");
      },
    });

    outbox.enqueue(receipt("3EB0AAA"));
    await outbox.idle();

    assert.equal(
      store.rows.size,
      0,
      "persistir 1.765 recibos por tempestade só enche o banco: o que precisa voltar é mensagem",
    );
  });
});
