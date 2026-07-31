import pino from "pino";

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
 */
export class SessionHealth {
  #lastInboundAt = null;
  #lastOutboundAt = null;
  #hourlyInbound = new Map();
  #alertedAt = null;

  constructor({
    silenceAlertMs = 45 * 60 * 1000,
    minBaselineSamples = 3,
    alertCooldownMs = 60 * 60 * 1000,
    notifier = null,
  } = {}) {
    this.silenceAlertMs = silenceAlertMs;
    this.minBaselineSamples = minBaselineSamples;
    this.alertCooldownMs = alertCooldownMs;
    this.notifier = notifier;
  }

  recordInbound() {
    const now = Date.now();
    this.#lastInboundAt = now;

    const hour = new Date(now).getUTCHours();
    const bucket = this.#hourlyInbound.get(hour) ?? { days: new Set(), count: 0 };
    bucket.days.add(new Date(now).toISOString().slice(0, 10));
    bucket.count += 1;
    this.#hourlyInbound.set(hour, bucket);
  }

  recordOutbound() {
    this.#lastOutboundAt = Date.now();
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
    const minutes = Math.round(silenceMs / 60000);
    logger.error(
      { silenceMinutes: minutes, hour },
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

  snapshot() {
    return {
      lastInboundAt: this.#lastInboundAt,
      lastOutboundAt: this.#lastOutboundAt,
      silenceMs: this.#lastInboundAt ? Date.now() - this.#lastInboundAt : null,
      trackedHours: this.#hourlyInbound.size,
    };
  }
}
