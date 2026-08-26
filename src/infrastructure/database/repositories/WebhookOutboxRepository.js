import { getDatabase } from "../connection.js";

const DELIVERED_RETENTION_DAYS = 3;
const RECOVER_BATCH = 200;

export class WebhookOutboxRepository {
  #retentionDays;
  #batchSize;

  constructor({
    retentionDays = DELIVERED_RETENTION_DAYS,
    batchSize = RECOVER_BATCH,
  } = {}) {
    this.#retentionDays = retentionDays;
    this.#batchSize = batchSize;
  }

  get db() {
    return getDatabase();
  }

  async enqueue({ lane, phone, messageId, payload }) {
    const rows = await this.db`
      INSERT INTO webhook_outbox (lane, phone, message_id, payload)
      VALUES (${lane}, ${phone || null}, ${messageId || null}, ${this.db.json(payload)})
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  }

  async markDelivered(id) {
    await this.db`
      UPDATE webhook_outbox
      SET status = 'delivered', delivered_at = now()
      WHERE id = ${id}
    `;
  }

  async defer(id, { attempts, lastError, nextAttemptAt }) {
    await this.db`
      UPDATE webhook_outbox
      SET attempts = ${attempts},
          last_error = ${lastError ?? null},
          next_attempt_at = ${nextAttemptAt}
      WHERE id = ${id}
    `;
  }

  async markDead(id, { lastError }) {
    await this.db`
      UPDATE webhook_outbox
      SET status = 'dead', last_error = ${lastError ?? null}
      WHERE id = ${id}
    `;
  }

  async listPending() {
    const rows = await this.db`
      UPDATE webhook_outbox
      SET next_attempt_at = now() + interval '15 minutes'
      WHERE id IN (
        SELECT id FROM webhook_outbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${this.#batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, lane, phone, message_id, payload, attempts
    `;

    return rows.map((row) => ({
      id: row.id,
      lane: row.lane,
      phone: row.phone,
      messageId: row.message_id,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async pruneDelivered() {
    const rows = await this.db`
      DELETE FROM webhook_outbox
      WHERE status = 'delivered'
        AND delivered_at < now() - ${`${this.#retentionDays} days`}::interval
      RETURNING id
    `;
    return rows.length;
  }

  async stats() {
    const rows = await this.db`
      SELECT status, count(*)::int AS total
      FROM webhook_outbox
      GROUP BY status
    `;
    return Object.fromEntries(rows.map((r) => [r.status, r.total]));
  }
}
