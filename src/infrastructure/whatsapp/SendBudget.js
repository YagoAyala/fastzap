import pino from "pino";
import { getDatabase } from "../database/connection.js";

const logger = pino({ level: "info" }).child({ module: "SendBudget" });

/**
 * Orçamento de envio, persistido.
 *
 * A versão em memória zerava a cada restart — e restart é exatamente o cenário
 * em que o orçamento importa, porque crash-loop com retry é como uma rajada
 * acidental nasce. Um limite que se perde sozinho não é limite.
 *
 * Política por faixa, e a assimetria é deliberada:
 *
 * - REATIVO nunca é recusado, nem acima do teto. Negar resposta a quem pagou e
 *   escreveu é pior que o risco marginal da mensagem nº 2001. Aqui o cap é
 *   alarme de fumaça: se o reativo sozinho estoura o teto com esta base, algo
 *   está em loop e você quer saber disso.
 * - PROATIVO é recusado. É o tráfego que queima número, e adiar um briefing não
 *   machuca ninguém.
 *
 * A escrita é write-behind: contar não pode atrasar o envio, e perder um
 * incremento num crash é infinitamente mais barato que travar a fila.
 */
const DAY = () => new Date().toISOString().slice(0, 10);
const HOUR = () => new Date().toISOString().slice(0, 13);

export class SendBudget {
  #cache = new Map();
  #pendingWrites = new Map();
  #flushTimer = null;

  constructor({
    sessionId = "default",
    dailyLimit = 2000,
    hourlyLimit = 250,
    perRecipientDailyLimit = 20,
  } = {}) {
    this.sessionId = sessionId;
    this.dailyLimit = dailyLimit;
    this.hourlyLimit = hourlyLimit;
    this.perRecipientDailyLimit = perRecipientDailyLimit;
  }

  /** Carrega os contadores do dia/hora corrente uma vez, no boot. */
  async load() {
    try {
      const db = getDatabase();
      const { rows } = await db.query(
        `SELECT bucket_key, count FROM outbound_counters
         WHERE session_id = $1 AND updated_at > now() - interval '2 days'`,
        [this.sessionId]
      );
      for (const row of rows) {
        this.#cache.set(row.bucket_key, Number(row.count));
      }
      logger.info({ buckets: rows.length }, "Orçamento de envio carregado");
    } catch (error) {
      // Falha ao carregar não pode derrubar o boot: sem contador, o pior caso é
      // um dia de orçamento cheio — muito melhor que o gateway não subir.
      logger.warn({ error: error?.message }, "Falha ao carregar orçamento");
    }
  }

  #get(key) {
    return this.#cache.get(key) ?? 0;
  }

  check({ lane = "proactive", jid = "" }) {
    if (lane === "reactive") {
      const dayUsed = this.#get(`d:${DAY()}`);
      if (dayUsed >= this.dailyLimit) {
        logger.error(
          { dayUsed, limit: this.dailyLimit },
          "Teto diário estourado no REATIVO — provável loop, investigar"
        );
      }
      return { allowed: true };
    }

    const dayUsed = this.#get(`d:${DAY()}`);
    if (dayUsed >= this.dailyLimit) {
      return { allowed: false, reason: "daily_limit" };
    }

    const hourUsed = this.#get(`h:${HOUR()}`);
    if (hourUsed >= this.hourlyLimit) {
      return { allowed: false, reason: "hourly_limit" };
    }

    if (jid) {
      const used = this.#get(`r:${jid}:${DAY()}`);
      if (used >= this.perRecipientDailyLimit) {
        return { allowed: false, reason: "recipient_limit" };
      }
    }

    return { allowed: true };
  }

  commit({ jid = "" }) {
    const keys = [`d:${DAY()}`, `h:${HOUR()}`];
    if (jid) keys.push(`r:${jid}:${DAY()}`);

    for (const key of keys) {
      this.#cache.set(key, this.#get(key) + 1);
      this.#pendingWrites.set(key, this.#cache.get(key));
    }
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush().catch(() => {});
    }, 5000);
    this.#flushTimer.unref?.();
  }

  async #flush() {
    if (this.#pendingWrites.size === 0) return;
    const batch = [...this.#pendingWrites.entries()];
    this.#pendingWrites.clear();

    try {
      const db = getDatabase();
      for (const [key, count] of batch) {
        await db.query(
          `INSERT INTO outbound_counters (session_id, bucket_key, count, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (session_id, bucket_key)
           DO UPDATE SET count = GREATEST(outbound_counters.count, EXCLUDED.count),
                         updated_at = now()`,
          [this.sessionId, key, count]
        );
      }
    } catch (error) {
      logger.warn({ error: error?.message }, "Falha ao persistir orçamento");
    }
  }

  snapshot() {
    return {
      day: { used: this.#get(`d:${DAY()}`), limit: this.dailyLimit },
      hour: { used: this.#get(`h:${HOUR()}`), limit: this.hourlyLimit },
      perRecipientDailyLimit: this.perRecipientDailyLimit,
    };
  }
}
