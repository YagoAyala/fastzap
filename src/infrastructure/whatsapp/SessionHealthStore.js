import pino from "pino";
import { getDatabase } from "../database/connection.js";

const logger = pino({ level: "info" }).child({ module: "SessionHealthStore" });

/**
 * Persistência da linha de base do vigia de silêncio.
 *
 * A baseline exige 3 dias de observação na MESMA faixa de hora, e vivia só em
 * memória. Consequência medida: o container subiu em 31/07/2026 15:19Z e
 * atravessou toda a janela pós-migração sem baseline — o vigia ficou cego
 * exatamente nos dias em que um shadowban seria mais provável. E cada deploy
 * zerava de novo, ou seja, a vigia era desligada justamente pelo ato que mais
 * mexe no sistema.
 *
 * Segue o padrão do SendBudget: leitura única no boot, escrita write-behind, e
 * falha de banco NUNCA derruba nada — vigia sem histórico é ruim, gateway que
 * não sobe é pior.
 */
export class SessionHealthStore {
  #sessionId;
  #retentionDays;

  constructor({ sessionId = "default", retentionDays = 30 } = {}) {
    this.#sessionId = sessionId;
    this.#retentionDays = retentionDays;
  }

  get sessionId() {
    return this.#sessionId;
  }

  async load() {
    try {
      const db = getDatabase();

      const [state] = await db`
        SELECT last_inbound_at, last_outbound_at, alerted_at
        FROM session_health
        WHERE session_id = ${this.#sessionId}
      `;

      const hours = await db`
        SELECT hour, day, count
        FROM session_health_hours
        WHERE session_id = ${this.#sessionId}
          AND day > current_date - ${this.#retentionDays}::int
      `;

      return {
        lastInboundAt: toEpochMs(state?.last_inbound_at),
        lastOutboundAt: toEpochMs(state?.last_outbound_at),
        alertedAt: toEpochMs(state?.alerted_at),
        hours: hours.map((row) => ({
          hour: Number(row.hour),
          day: toIsoDay(row.day),
          count: Number(row.count),
        })),
      };
    } catch (error) {
      logger.warn(
        { error: error?.message },
        "Falha ao carregar linha de base do vigia",
      );
      return null;
    }
  }

  async persist({ lastInboundAt, lastOutboundAt, alertedAt, hours = [] }) {
    try {
      const db = getDatabase();

      await db`
        INSERT INTO session_health (session_id, last_inbound_at, last_outbound_at, alerted_at, updated_at)
        VALUES (
          ${this.#sessionId},
          ${toDate(lastInboundAt)},
          ${toDate(lastOutboundAt)},
          ${toDate(alertedAt)},
          now()
        )
        ON CONFLICT (session_id) DO UPDATE SET
          last_inbound_at = EXCLUDED.last_inbound_at,
          last_outbound_at = EXCLUDED.last_outbound_at,
          alerted_at = EXCLUDED.alerted_at,
          updated_at = now()
      `;

      for (const bucket of hours) {
        await db`
          INSERT INTO session_health_hours (session_id, hour, day, count, updated_at)
          VALUES (${this.#sessionId}, ${bucket.hour}::smallint, ${bucket.day}::date, ${bucket.count}, now())
          ON CONFLICT (session_id, hour, day)
          DO UPDATE SET count = GREATEST(session_health_hours.count, EXCLUDED.count),
                        updated_at = now()
        `;
      }
    } catch (error) {
      logger.warn(
        { error: error?.message },
        "Falha ao persistir linha de base do vigia",
      );
    }
  }

  /** Poda o histórico fora da janela de retenção. Barato e raro. */
  async prune() {
    try {
      const db = getDatabase();
      await db`
        DELETE FROM session_health_hours
        WHERE session_id = ${this.#sessionId}
          AND day <= current_date - ${this.#retentionDays}::int
      `;
    } catch (error) {
      logger.warn({ error: error?.message }, "Falha ao podar linha de base");
    }
  }
}

const toEpochMs = (value) => {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const toDate = (epochMs) =>
  Number.isFinite(epochMs) && epochMs ? new Date(epochMs) : null;

// O driver devolve `day` como Date (coluna date). `toISOString()` num Date que
// veio de uma coluna `date` já está em UTC à meia-noite, então o slice é seguro
// — e é a mesma chave que o SessionHealth monta em memória.
const toIsoDay = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
