import pino from "pino";

const logger = pino({ level: "info" }).child({ module: "DeliveryTracker" });

/**
 * Vigia de ENTREGA — o buraco que sobra depois do recibo.
 *
 * O `messages.update` do Baileys cobre dois desfechos: entregou (delivered/read)
 * e o servidor recusou a stanza (status ERROR → 'failed'). O terceiro desfecho
 * não gera evento NENHUM: a stanza foi aceita, ganhou wamid, e o recibo simples-
 * mente nunca chega. Do lado de fora isso é indistinguível de sucesso — a rota
 * devolveu 200 com messageId e ninguém volta pra perguntar o que aconteceu.
 *
 * Medido no banco da Focca em 03/08/2026: de 261 envios com mais de 1h de vida,
 * 13 (5%) nunca chegaram a `delivered`/`read` e nenhum callback avisou. É o
 * "aceitei mas não entreguei" — o modo de falha que a sentinela de entrega
 * deveria pegar e não pegava, porque a ausência de evento não é evento.
 *
 * Aqui a ausência VIRA evento: todo envio rastreável entra num mapa e, se não
 * for liquidado dentro do prazo, sai como status `undelivered`.
 *
 * O rótulo é `undelivered` e não `failed` de propósito. `failed` é veredito do
 * servidor ("recusei"); aqui é inferência por silêncio, e um aparelho desligado
 * por 20 minutos produz exatamente o mesmo silêncio de uma entrega morta.
 * Misturar os dois contaminaria justamente a métrica que precisa continuar
 * confiável.
 */

// Só estes encerram o assunto. `sent`/`pending` são estados INTERMEDIÁRIOS: a
// stanza chegou ao servidor do WhatsApp, não ao aparelho — tratar isso como
// entrega é o falso-verde que este vigia existe pra matar.
const SETTLING_STATUSES = new Set(["delivered", "read", "played", "failed"]);

export class DeliveryTracker {
  #pending = new Map();
  #timer = null;
  #undeliveredCount = 0;

  constructor({
    ackTimeoutMs = 15 * 60 * 1000,
    sweepIntervalMs = 60 * 1000,
    maxPending = 5000,
    onUndelivered = null,
    now = () => Date.now(),
  } = {}) {
    this.ackTimeoutMs = ackTimeoutMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.maxPending = maxPending;
    this.onUndelivered = onUndelivered;
    this.now = now;
  }

  /**
   * Grupo NÃO entra: o Baileys emite `message-receipt.update` (por participante)
   * para grupo e `messages.update` só para conversa privada — rastrear grupo
   * aqui produziria 100% de `undelivered` falso, para sempre.
   */
  static isTrackable(jid, content) {
    if (!jid || String(jid).endsWith("@g.us")) return false;
    // Reação é recibo, não mensagem: some da lista de "não entregue" porque o
    // WhatsApp não emite recibo de entrega para ela.
    if (content && typeof content === "object" && content.react) return false;
    return true;
  }

  track(messageId, jid) {
    if (!messageId) return false;

    if (this.#pending.size >= this.maxPending) {
      // Descarta o mais ANTIGO: o mapa é diagnóstico, não fila. Crescer sem teto
      // trocaria cegueira de entrega por OOM, que é pior.
      const oldest = this.#pending.keys().next().value;
      this.#pending.delete(oldest);
      logger.warn(
        { maxPending: this.maxPending },
        "Mapa de entregas pendentes no teto — descartando o mais antigo",
      );
    }

    this.#pending.set(messageId, { jid, sentAt: this.now() });
    return true;
  }

  /** @returns {boolean} true se este id estava mesmo pendente. */
  settle(messageId, status) {
    if (!messageId || !SETTLING_STATUSES.has(status)) return false;
    return this.#pending.delete(messageId);
  }

  /**
   * Emite `undelivered` para tudo que passou do prazo. Devolve o que emitiu para
   * quem quiser contar sem espiar estado privado.
   */
  sweep() {
    const now = this.now();
    const expired = [];

    for (const [messageId, entry] of this.#pending) {
      const ageMs = now - entry.sentAt;
      if (ageMs < this.ackTimeoutMs) continue;
      expired.push({ messageId, jid: entry.jid, ageMs });
    }

    for (const item of expired) {
      this.#pending.delete(item.messageId);
      this.#undeliveredCount += 1;
      logger.error(
        {
          event: "delivery_undelivered",
          messageId: item.messageId,
          jid: item.jid,
          ageMinutes: Math.round(item.ageMs / 60000),
        },
        "Mensagem aceita sem recibo de entrega dentro do prazo",
      );
      try {
        this.onUndelivered?.(item);
      } catch (error) {
        logger.warn(
          { error: error?.message },
          "Falha ao notificar entrega não confirmada",
        );
      }
    }

    return expired;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        logger.warn({ error: error?.message }, "Falha na varredura de entregas");
      }
    }, this.sweepIntervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  stats() {
    return {
      pending: this.#pending.size,
      undelivered: this.#undeliveredCount,
      ackTimeoutMs: this.ackTimeoutMs,
    };
  }
}
