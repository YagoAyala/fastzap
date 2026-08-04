import pino from "pino";
import { SessionHealthStore } from "./SessionHealthStore.js";

const logger = pino({ level: "info" }).child({ module: "SessionHealth" });

/**
 * Vigia de saúde da sessão — desenhado para pegar SHADOWBAN.
 *
 * Falha dura (socket cai, 403, container morre) você descobre de vários jeitos.
 * O modo que mata em silêncio é outro: a sessão continua autenticada, o envio
 * continua "dando sucesso", e simplesmente nada chega nem volta. Nenhum erro,
 * nenhum log, nenhum alerta — só o produto morrendo enquanto todo painel diz ✅.
 *
 * O único sintoma observável desse estado é a AUSÊNCIA de tráfego de entrada.
 * Por isso o alerta é sobre silêncio, não sobre erro.
 *
 * O cuidado que evita alarme falso: silêncio às 4h da manhã é normal. Só alerta
 * se a mesma faixa de hora costumava ter tráfego — a baseline vem do próprio
 * histórico observado, então o vigia se calibra sozinho conforme o produto muda.
 *
 * Essa baseline agora VIVE NO BANCO. Enquanto era só memória, o vigia precisava
 * de 3 dias no ar para servir pra alguma coisa e cada deploy o devolvia à
 * estaca zero — um alarme que se desarma sozinho toda vez que o sistema muda é
 * pior que nenhum, porque parece que existe.
 */
export class SessionHealth {
  #lastInboundAt = null;
  #lastOutboundAt = null;
  #hourlyInbound = new Map();
  #alertedAt = null;
  #store;
  #dirtyHours = new Map();
  #dirtyState = false;
  #flushTimer = null;
  #loaded = false;

  constructor({
    silenceAlertMs = 45 * 60 * 1000,
    minBaselineSamples = 3,
    alertCooldownMs = 60 * 60 * 1000,
    notifier = null,
    sessionId = "default",
    store = null,
    flushDelayMs = 5000,
  } = {}) {
    this.silenceAlertMs = silenceAlertMs;
    this.minBaselineSamples = minBaselineSamples;
    this.alertCooldownMs = alertCooldownMs;
    this.notifier = notifier;
    this.flushDelayMs = flushDelayMs;
    this.#store = store ?? new SessionHealthStore({ sessionId });
  }

  get loaded() {
    return this.#loaded;
  }

  /** Reidrata a baseline do banco. Idempotente e à prova de banco fora do ar. */
  async load() {
    const snapshot = await this.#store.load();
    if (!snapshot) return false;
    this.#loaded = true;

    this.#lastInboundAt = snapshot.lastInboundAt ?? null;
    this.#lastOutboundAt = snapshot.lastOutboundAt ?? null;
    this.#alertedAt = snapshot.alertedAt ?? null;

    for (const row of snapshot.hours ?? []) {
      const bucket = this.#bucketFor(row.hour);
      bucket.days.add(row.day);
      bucket.count += row.count;
    }

    logger.info(
      {
        trackedHours: this.#hourlyInbound.size,
        hasBaseline: this.#lastInboundAt != null,
      },
      "Linha de base do vigia carregada",
    );
    return true;
  }

  #bucketFor(hour) {
    const existing = this.#hourlyInbound.get(hour);
    if (existing) return existing;
    const bucket = { days: new Set(), count: 0 };
    this.#hourlyInbound.set(hour, bucket);
    return bucket;
  }

  recordInbound() {
    const now = Date.now();
    this.#lastInboundAt = now;

    const hour = new Date(now).getUTCHours();
    const day = new Date(now).toISOString().slice(0, 10);
    const bucket = this.#bucketFor(hour);
    bucket.days.add(day);
    bucket.count += 1;

    this.#dirtyHours.set(`${hour}:${day}`, {
      hour,
      day,
      // Contagem do dia corrente nessa hora — o GREATEST do upsert cuida de não
      // regredir quando duas instâncias escrevem.
      count: bucket.count,
    });
    this.#markDirty();
  }

  recordOutbound() {
    this.#lastOutboundAt = Date.now();
    this.#markDirty();
  }

  /** Esta faixa de hora costuma ter movimento? */
  #hourIsUsuallyActive(hour) {
    const bucket = this.#hourlyInbound.get(hour);
    return Boolean(bucket && bucket.days.size >= this.minBaselineSamples);
  }

  check() {
    if (!this.#lastInboundAt) return { silent: false, reason: "sem_baseline" };

    const now = Date.now();
    const silenceMs = now - this.#lastInboundAt;
    if (silenceMs < this.silenceAlertMs) return { silent: false, silenceMs };

    const hour = new Date(now).getUTCHours();
    if (!this.#hourIsUsuallyActive(hour)) {
      return { silent: false, reason: "hora_normalmente_parada", silenceMs };
    }

    if (this.#alertedAt && now - this.#alertedAt < this.alertCooldownMs) {
      return { silent: true, alreadyAlerted: true, silenceMs };
    }

    this.#alertedAt = now;
    this.#markDirty();
    const minutes = Math.round(silenceMs / 60000);
    logger.error(
      { event: "session_silent", silenceMinutes: minutes, hour },
      "Silêncio de entrada em horário normalmente ativo — possível shadowban",
    );
    this.notifier
      ?.notify?.(
        `⚠️ *WhatsApp sem mensagens há ${minutes} min*\n\n` +
          `Esta faixa de horário costuma ter movimento. A sessão continua ` +
          `autenticada e os envios seguem "dando sucesso" — que é exatamente ` +
          `como um shadowban se parece.\n\n` +
          `Manda uma mensagem pro número de outro aparelho pra confirmar.`,
      )
      ?.catch?.(() => {});

    return { silent: true, silenceMs, alerted: true };
  }

  #markDirty() {
    this.#dirtyState = true;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush().catch(() => {});
    }, this.flushDelayMs);
    this.#flushTimer.unref?.();
  }

  /** Write-behind: contar tráfego nunca pode ficar esperando o banco. */
  async flush() {
    if (!this.#dirtyState && this.#dirtyHours.size === 0) return;

    const hours = [...this.#dirtyHours.values()];
    this.#dirtyHours.clear();
    this.#dirtyState = false;

    await this.#store.persist({
      lastInboundAt: this.#lastInboundAt,
      lastOutboundAt: this.#lastOutboundAt,
      alertedAt: this.#alertedAt,
      hours,
    });
  }

  stop() {
    if (!this.#flushTimer) return;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }

  snapshot() {
    return {
      lastInboundAt: this.#lastInboundAt,
      lastOutboundAt: this.#lastOutboundAt,
      silenceMs: this.#lastInboundAt ? Date.now() - this.#lastInboundAt : null,
      trackedHours: this.#hourlyInbound.size,
      baselineHours: [...this.#hourlyInbound.entries()].filter(
        ([, bucket]) => bucket.days.size >= this.minBaselineSamples,
      ).length,
      // `false` aqui significa que o vigia está reaprendendo do zero — é o
      // estado em que ele NÃO protege, e precisa ser visível no /health.
      baselineRestored: this.#loaded,
    };
  }
}
