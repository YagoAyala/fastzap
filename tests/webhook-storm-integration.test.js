import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const startSlowWebhook = async ({ delayMs = 25 } = {}) => {
  const received = [];
  let peakConcurrent = 0;
  let concurrent = 0;

  const server = http.createServer((req, res) => {
    concurrent += 1;
    peakConcurrent = Math.max(peakConcurrent, concurrent);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      setTimeout(() => {
        received.push({ at: Date.now(), payload: JSON.parse(body) });
        concurrent -= 1;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("EVENT_RECEIVED");
      }, delayMs);
    });
  });

  server.keepAliveTimeout = 5000;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/api/whatsapp/baileys`,
    received,
    peak: () => peakConcurrent,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe("tempestade de recibos contra um webhook real e lento", () => {
  test("comprovante do usuário chega rápido e nada se perde", async () => {
    const webhook = await startSlowWebhook({ delayMs: 25 });

    process.env.API_TOKEN ??= "test-token";
    process.env.QR_ACCESS_TOKEN ??= "test-qr-token";
    process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
    process.env.WEBHOOK_URL = webhook.url;
    process.env.WEBHOOK_CONCURRENCY = "4";
    process.env.WEBHOOK_TIMEOUT_MS = "10000";
    process.env.WEBHOOK_RETRY_DELAY_MS = "50";

    const { WebhookDispatcher } = await import(
      `../src/infrastructure/webhook/WebhookDispatcher.js?storm=${Date.now()}`
    );

    const listeners = { message: [], status: [] };
    const manager = {
      onMessage: (fn) => listeners.message.push(fn),
      onMessageStatus: (fn) => listeners.status.push(fn),
      getClient: () => null,
    };

    const dispatcher = new WebhookDispatcher(manager);
    const outbox = dispatcher.outbox;

    const comecou = Date.now();

    for (let i = 0; i < 473; i += 1) {
      outbox.enqueue({
        instanceId: "focca",
        type: "MessageStatusCallback",
        phone: "111914298384448",
        messageId: `3EB0${i}`,
        status: "sent",
        fromMe: true,
      });
    }

    outbox.enqueue({
      instanceId: "focca",
      type: "ReceivedCallback",
      phone: "5547992512269",
      chatName: "Yago",
      fromMe: false,
      messageId: "COMPROVANTE-858-66",
      document: {
        fileName: "Comprovante-98C28E6A.pdf",
        base64: "J".repeat(73932),
      },
    });

    await outbox.idle();
    await webhook.close();

    const comprovante = webhook.received.find(
      (r) => r.payload.messageId === "COMPROVANTE-858-66",
    );

    assert.ok(comprovante, "o comprovante NÃO pode sumir, esse é o bug inteiro");

    const esperaMs = comprovante.at - comecou;
    assert.ok(
      esperaMs < 2000,
      `comprovante levou ${esperaMs}ms atrás de 473 recibos: em 26/08 essa espera ` +
        `passou dos 10s de timeout três vezes e o PDF foi descartado`,
    );

    assert.equal(
      webhook.received.length,
      474,
      "limitar concorrência não pode virar perda de evento",
    );

    assert.ok(
      webhook.peak() <= 6,
      `pico de ${webhook.peak()} conexões simultâneas no servidor: o incidente foi com 352`,
    );

    assert.equal(outbox.snapshot().dead, 0);
    assert.equal(outbox.snapshot().shed, 0);
  });
});
