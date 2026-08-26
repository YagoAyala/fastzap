import pino from "pino";

const defaultLogger = pino({ level: "info" }).child({ module: "WebhookOutbox" });

export const LANE_MESSAGE = "message";
export const LANE_RECEIPT = "receipt";

export const laneOf = (payload) =>
  payload?.type === "ReceivedCallback" ? LANE_MESSAGE : LANE_RECEIPT;

const describeError = (error) => ({
  error: error?.message ?? String(error ?? "erro desconhecido"),
  code: error?.code ?? null,
});

export class WebhookOutbox {
  #transport;
  #store;
  #alerts;
  #logger;
  #concurrency;
  #maxAttempts;
  #deadAfterAttempts;
  #retryDelayMs;
  #receiptQueueCap;
  #backlogAlertThreshold;
  #sleep;
  #now;

  #queues = { [LANE_MESSAGE]: [], [LANE_RECEIPT]: [] };
  #phonesInFlight = new Set();
  #inFlight = 0;
  #persistsInFlight = 0;
  #idleWaiters = [];
  #stopped = false;

  #counters = {
    delivered: 0,
    deferred: 0,
    dead: 0,
    shed: 0,
    receiptsGivenUp: 0,
  };

  constructor({
    transport,
    store = null,
    alerts = null,
    logger = defaultLogger,
    concurrency = 4,
    maxAttempts = 3,
    deadAfterAttempts = 15,
    retryDelayMs = 1000,
    receiptQueueCap = 5000,
    backlogAlertThreshold = 500,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  }) {
    this.#transport = transport;
    this.#store = store;
    this.#alerts = alerts;
    this.#logger = logger;
    this.#concurrency = Math.max(1, concurrency);
    this.#maxAttempts = Math.max(1, maxAttempts);
    this.#deadAfterAttempts = Math.max(this.#maxAttempts, deadAfterAttempts);
    this.#retryDelayMs = retryDelayMs;
    this.#receiptQueueCap = receiptQueueCap;
    this.#backlogAlertThreshold = backlogAlertThreshold;
    this.#sleep = sleep;
    this.#now = now;
  }

  get durable() {
    return Boolean(this.#store);
  }

  enqueue(payload) {
    if (this.#stopped) {
      this.#logger.warn(
        { event: "webhook_outbox_enqueue_after_stop" },
        "Evento chegou depois do shutdown",
      );
      return;
    }

    const lane = laneOf(payload);
    const item = {
      lane,
      payload,
      phone: String(payload?.phone ?? ""),
      messageId: payload?.messageId ?? null,
      attempts: 0,
      rowId: null,
      awaitingPersist: false,
    };

    if (lane === LANE_RECEIPT) {
      this.#queues[LANE_RECEIPT].push(item);
      this.#shedReceiptsOverCap();
      this.#warnOnBacklog();
      this.#pump();
      return;
    }

    item.awaitingPersist = Boolean(this.#store);
    this.#queues[LANE_MESSAGE].push(item);

    if (!item.awaitingPersist) {
      this.#warnOnBacklog();
      this.#pump();
      return;
    }

    this.#persistsInFlight += 1;
    this.#persist(item).finally(() => {
      this.#persistsInFlight -= 1;
      item.awaitingPersist = false;
      this.#warnOnBacklog();
      this.#pump();
    });
  }

  async #persist(item) {
    try {
      item.rowId = await this.#store.enqueue({
        lane: item.lane,
        phone: item.phone,
        messageId: item.messageId,
        payload: item.payload,
      });
    } catch (error) {
      this.#logger.error(
        {
          event: "webhook_outbox_persist_failed",
          phone: item.phone,
          messageId: item.messageId,
          ...describeError(error),
        },
        "Não consegui gravar a mensagem no outbox — seguindo sem durabilidade",
      );
    }
  }

  #shedReceiptsOverCap() {
    const queue = this.#queues[LANE_RECEIPT];
    if (queue.length <= this.#receiptQueueCap) return;

    const dropped = queue.length - this.#receiptQueueCap;
    queue.splice(0, dropped);
    this.#counters.shed += dropped;

    this.#logger.error(
      {
        event: "webhook_outbox_receipts_shed",
        dropped,
        cap: this.#receiptQueueCap,
        shedTotal: this.#counters.shed,
      },
      "Fila de recibos no teto — descartando os mais antigos",
    );

    this.#alerts?.webhookShed?.({
      reason: "queue_cap",
      dropped,
      cap: this.#receiptQueueCap,
      shedTotal: this.#counters.shed,
    });
  }

  #warnOnBacklog() {
    const queued = this.#queuedTotal();
    if (queued < this.#backlogAlertThreshold) return;

    this.#alerts?.webhookBacklog?.({
      queued,
      messages: this.#queues[LANE_MESSAGE].length,
      receipts: this.#queues[LANE_RECEIPT].length,
      inFlight: this.#inFlight,
    });
  }

  #queuedTotal() {
    return this.#queues[LANE_MESSAGE].length + this.#queues[LANE_RECEIPT].length;
  }

  #takeNext() {
    const messages = this.#queues[LANE_MESSAGE];
    for (let i = 0; i < messages.length; i += 1) {
      const candidate = messages[i];
      if (candidate.awaitingPersist) continue;
      if (candidate.phone && this.#phonesInFlight.has(candidate.phone)) continue;
      messages.splice(i, 1);
      return candidate;
    }

    return this.#queues[LANE_RECEIPT].shift() ?? null;
  }

  #pump() {
    while (!this.#stopped && this.#inFlight < this.#concurrency) {
      const item = this.#takeNext();
      if (!item) break;

      this.#inFlight += 1;
      if (item.lane === LANE_MESSAGE && item.phone) {
        this.#phonesInFlight.add(item.phone);
      }

      this.#deliver(item)
        .catch((error) =>
          this.#logger.error(
            { event: "webhook_outbox_deliver_crashed", ...describeError(error) },
            "Falha inesperada na entrega",
          ),
        )
        .finally(() => {
          this.#inFlight -= 1;
          if (item.lane === LANE_MESSAGE && item.phone) {
            this.#phonesInFlight.delete(item.phone);
          }
          this.#pump();
        });
    }

    this.#settleIdleWaiters();
  }

  async #deliver(item) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      item.attempts += 1;
      try {
        await this.#transport(item.payload);
        this.#counters.delivered += 1;
        await this.#markDelivered(item);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.#maxAttempts) {
          await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    await this.#giveUp(item, lastError);
  }

  async #markDelivered(item) {
    if (!item.rowId || !this.#store) return;
    try {
      await this.#store.markDelivered(item.rowId);
    } catch (error) {
      this.#logger.warn(
        {
          event: "webhook_outbox_mark_delivered_failed",
          rowId: item.rowId,
          ...describeError(error),
        },
        "Entregue mas não consegui baixar a linha do outbox",
      );
    }
  }

  async #giveUp(item, error) {
    const detail = {
      lane: item.lane,
      phone: item.phone,
      messageId: item.messageId,
      attempts: item.attempts,
      ...describeError(error),
    };

    if (item.lane === LANE_RECEIPT) {
      this.#counters.receiptsGivenUp += 1;
      this.#logger.error(
        { event: "webhook_outbox_receipt_lost", ...detail },
        "Recibo de entrega perdido",
      );
      this.#alerts?.webhookShed?.({
        reason: "retry_exhausted",
        dropped: 1,
        shedTotal: this.#counters.shed + this.#counters.receiptsGivenUp,
      });
      return;
    }

    if (!item.rowId) {
      this.#counters.dead += 1;
      this.#logger.error(
        { event: "webhook_outbox_message_lost", ...detail },
        "Mensagem de usuário perdida sem cópia durável",
      );
      this.#alerts?.webhookDead?.({ ...detail, durable: false });
      return;
    }

    if (item.attempts >= this.#deadAfterAttempts) {
      this.#counters.dead += 1;
      await this.#store
        .markDead(item.rowId, { lastError: detail.error })
        .catch(() => {});
      this.#logger.error(
        { event: "webhook_outbox_message_dead", rowId: item.rowId, ...detail },
        "Mensagem de usuário no teto de tentativas",
      );
      this.#alerts?.webhookDead?.({ ...detail, durable: true });
      return;
    }

    const backoffMs = Math.min(
      this.#retryDelayMs * 2 ** item.attempts,
      15 * 60 * 1000,
    );

    this.#counters.deferred += 1;
    await this.#store
      .defer(item.rowId, {
        attempts: item.attempts,
        lastError: detail.error,
        nextAttemptAt: new Date(this.#now() + backoffMs),
      })
      .catch(() => {});

    this.#logger.error(
      { event: "webhook_outbox_message_deferred", rowId: item.rowId, ...detail },
      "Mensagem de usuário adiada para o dreno",
    );
    this.#alerts?.webhookRetryExhausted?.({ ...detail, retryInMs: backoffMs });
  }

  async recover() {
    if (!this.#store) return 0;

    let rows = [];
    try {
      rows = await this.#store.listPending();
    } catch (error) {
      this.#logger.error(
        { event: "webhook_outbox_recover_failed", ...describeError(error) },
        "Não consegui ler o outbox pendente",
      );
      return 0;
    }

    let recovered = 0;
    for (const row of rows) {
      if (row.lane !== LANE_MESSAGE) continue;
      this.#queues[LANE_MESSAGE].push({
        lane: LANE_MESSAGE,
        payload: row.payload,
        phone: String(row.phone ?? ""),
        messageId: row.messageId ?? null,
        attempts: row.attempts ?? 0,
        rowId: row.id,
        awaitingPersist: false,
      });
      recovered += 1;
    }

    if (recovered > 0) {
      this.#logger.warn(
        { event: "webhook_outbox_recovered", recovered },
        "Mensagens pendentes recuperadas do outbox",
      );
    }

    this.#pump();
    return recovered;
  }

  async tick() {
    const recovered = await this.recover();
    if (this.#store?.pruneDelivered) {
      await this.#store.pruneDelivered().catch(() => {});
    }
    return recovered;
  }

  #isIdle() {
    return (
      this.#inFlight === 0 &&
      this.#persistsInFlight === 0 &&
      this.#queuedTotal() === 0
    );
  }

  #settleIdleWaiters() {
    if (!this.#isIdle() || this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  idle() {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async stop({ timeoutMs = 8000 } = {}) {
    const drained = await Promise.race([
      this.idle().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);

    this.#stopped = true;

    if (!drained) {
      this.#logger.error(
        { event: "webhook_outbox_stop_timeout", ...this.snapshot() },
        "Shutdown com fila ainda cheia — o que estava persistido volta no próximo boot",
      );
    }

    return drained;
  }

  snapshot() {
    return {
      ...this.#counters,
      queuedMessages: this.#queues[LANE_MESSAGE].length,
      queuedReceipts: this.#queues[LANE_RECEIPT].length,
      inFlight: this.#inFlight,
      concurrency: this.#concurrency,
      durable: this.durable,
    };
  }
}
