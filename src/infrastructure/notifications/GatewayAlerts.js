import pino from "pino";

const logger = pino({ level: "info" }).child({ module: "GatewayAlerts" });

/**
 * O que o gateway grita quando algo importante acontece.
 *
 * Até 03/08/2026 nada aqui existia fora de `docker logs`: as 19 desconexões da
 * semana, as 8 falhas de webhook e os 5 envios recusados por cap só apareceram
 * porque alguém foi olhar na mão, por SSH. Nenhum alerta cobria o gateway —
 * inclusive os dois eventos que significam "o número caiu e o produto parou":
 * `loggedOut` e pedido de QR.
 *
 * Duas decisões que fazem este arquivo existir em vez de espalhar `notifier.
 * notify()` pelo código:
 *
 * 1. COOLDOWN. Reconexão em loop dispara o mesmo evento dezenas de vezes por
 *    hora; sem janela de silêncio o Telegram vira ruído e o alerta que importa
 *    se perde no meio. Alerta que ninguém lê é igual a alerta que não existe.
 * 2. LIMIAR. Uma desconexão é rotina de rede — sete numa hora é sintoma. O que
 *    precisa alertar é a TAXA, e taxa exige memória de janela em algum lugar.
 *
 * Todo alerta também sai como log estruturado com `event:`, porque o Telegram é
 * para acordar alguém e o log é para investigar depois.
 */
const HOUR = 60 * 60 * 1000;

export class GatewayAlerts {
  #notifier;
  #cooldowns = new Map();
  #disconnects = [];
  #sendFailures = [];
  #sendTotal = [];
  #undelivered = [];
  #webhookDeferrals = [];

  constructor({
    notifier = null,
    cooldownMs = 30 * 60 * 1000,
    windowMs = HOUR,
    disconnectThreshold = 6,
    sendFailureThreshold = 5,
    sendFailureRate = 0.2,
    undeliveredThreshold = 5,
    webhookDeferralThreshold = 3,
    now = () => Date.now(),
  } = {}) {
    this.#notifier = notifier;
    this.cooldownMs = cooldownMs;
    this.windowMs = windowMs;
    this.disconnectThreshold = disconnectThreshold;
    this.sendFailureThreshold = sendFailureThreshold;
    this.sendFailureRate = sendFailureRate;
    this.undeliveredThreshold = undeliveredThreshold;
    this.webhookDeferralThreshold = webhookDeferralThreshold;
    this.now = now;
  }

  /**
   * QR pedido é o alerta mais crítico do gateway.
   *
   * Uma sessão que já pareou nunca deveria pedir QR de novo. Quando pede, o
   * número saiu do ar e só volta com alguém apontando o celular para a tela —
   * ou seja, o produto está parado e vai continuar parado até uma ação humana
   * que ninguém sabe que precisa fazer.
   */
  qrRequested(sessionId) {
    this.#fire(
      `qr:${sessionId}`,
      { event: "session_qr_requested", sessionId },
      `🚨 *WhatsApp pedindo QR code*\n\n` +
        `*Sessão:* \`${sessionId}\`\n\n` +
        `A sessão perdeu o pareamento: o gateway não envia nem recebe nada até ` +
        `alguém escanear o QR. Abra \`/sessions/qr-screen\` e pareie de novo.`,
    );
  }

  /**
   * `loggedOut` / `forbidden` / `connectionReplaced` não reconectam sozinhos: o
   * cliente é removido do mapa e o gateway fica mudo em silêncio. É o único
   * caminho em que "nada mais funciona" não produz nem erro de envio.
   */
  sessionLost(sessionId, reason) {
    this.#fire(
      `lost:${sessionId}:${reason}`,
      { event: "session_lost", sessionId, reason },
      `🚨 *Sessão do WhatsApp perdida*\n\n` +
        `*Sessão:* \`${sessionId}\`\n` +
        `*Motivo:* ${reason}\n\n` +
        `Não há reconexão automática para este motivo. O gateway está mudo até ` +
        `alguém re-parear o número.`,
      { critical: true },
    );
  }

  /** Uma queda é rede. Muitas na mesma janela é sintoma de número em risco. */
  recordDisconnect(sessionId, reason) {
    this.#disconnects = this.#prune(this.#disconnects);
    this.#disconnects.push(this.now());

    logger.warn(
      { event: "session_disconnected", sessionId, reason },
      "Sessão desconectada",
    );

    if (this.#disconnects.length < this.disconnectThreshold) return;

    this.#fire(
      "disconnect_storm",
      {
        event: "session_disconnect_storm",
        sessionId,
        count: this.#disconnects.length,
      },
      `⚠️ *WhatsApp reconectando demais*\n\n` +
        `*Sessão:* \`${sessionId}\`\n` +
        `*Quedas na última hora:* ${this.#disconnects.length}\n\n` +
        `Cada queda é uma janela em que mensagem entra e não é respondida. ` +
        `Vale olhar rede da VM e saúde do número.`,
    );
  }

  /**
   * Taxa de erro de envio. Exige volume mínimo E proporção: 2 falhas em 3
   * envios num domingo de madrugada não é incidente, é amostra pequena.
   */
  recordSendResult({ ok, error = null }) {
    const now = this.now();
    this.#sendTotal = this.#prune(this.#sendTotal);
    this.#sendTotal.push(now);

    if (ok) return;

    this.#sendFailures = this.#prune(this.#sendFailures);
    this.#sendFailures.push(now);

    logger.warn({ event: "send_failed", error }, "Envio falhou");

    const failures = this.#sendFailures.length;
    const total = this.#sendTotal.length;
    if (failures < this.sendFailureThreshold) return;
    if (failures / Math.max(total, 1) < this.sendFailureRate) return;

    this.#fire(
      "send_failure_rate",
      { event: "send_failure_rate", failures, total },
      `⚠️ *Envios falhando no gateway*\n\n` +
        `*Falhas na última hora:* ${failures} de ${total} tentativas\n` +
        `*Último erro:* ${error ?? "desconhecido"}\n\n` +
        `Resposta a usuário está morrendo antes de sair.`,
    );
  }

  /**
   * Mensagem aceita que nunca recebeu recibo — a entrega morta e silenciosa.
   *
   * UMA delas não é incidente: aparelho desligado produz exatamente o mesmo
   * silêncio, e a taxa normal medida em produção é de ~4/dia (13 em 261 envios
   * de 3 dias). O que é sintoma é a SÉRIE — número restrito para de entregar em
   * bloco. Por isso o log sai sempre e o alerta espera o limiar.
   */
  undelivered({ messageId, jid, ageMs }) {
    logger.error(
      {
        event: "delivery_undelivered",
        messageId,
        jid,
        ageMinutes: Math.round(ageMs / 60000),
      },
      "Entrega não confirmada dentro do prazo",
    );

    this.#undelivered = this.#prune(this.#undelivered);
    this.#undelivered.push(this.now());

    if (this.#undelivered.length < this.undeliveredThreshold) return;

    this.#fire(
      "undelivered",
      { event: "delivery_undelivered_alert", count: this.#undelivered.length },
      `⚠️ *Mensagens saindo sem confirmação de entrega*\n\n` +
        `*Sem recibo na última hora:* ${this.#undelivered.length}\n` +
        `*Último destino:* ${jid ?? "?"}\n\n` +
        `O WhatsApp aceitou as stanzas e nunca confirmou entrega. Em série, ` +
        `esse é o sintoma clássico de número restrito.`,
    );
  }

  webhookRetryExhausted({ phone, messageId, attempts, error, retryInMs }) {
    logger.error(
      {
        event: "webhook_message_deferred",
        phone,
        messageId,
        attempts,
        error,
      },
      "Mensagem de usuário não entregue — adiada para o dreno",
    );

    this.#webhookDeferrals = this.#prune(this.#webhookDeferrals);
    this.#webhookDeferrals.push(this.now());

    if (this.#webhookDeferrals.length < this.webhookDeferralThreshold) return;

    this.#fire(
      "webhook_deferrals",
      {
        event: "webhook_deferral_storm",
        count: this.#webhookDeferrals.length,
      },
      `⚠️ *Mensagens de usuário não estão chegando na Focca*\n\n` +
        `*Adiadas na última hora:* ${this.#webhookDeferrals.length}\n` +
        `*Último erro:* ${error ?? "desconhecido"}\n` +
        `*Próxima tentativa em:* ${Math.round((retryInMs ?? 0) / 1000)}s\n\n` +
        `O payload está salvo no outbox e volta sozinho. Se isso não parar, ` +
        `o problema é a Focca ou a rede da VM.`,
    );
  }

  webhookDead({ phone, messageId, attempts, error, durable }) {
    this.#fire(
      `webhook_dead:${messageId ?? phone}`,
      { event: "webhook_message_dead", phone, messageId, attempts, durable },
      `🚨 *Mensagem de usuário perdida*\n\n` +
        `*De:* \`${phone ?? "?"}\`\n` +
        `*Id:* \`${messageId ?? "?"}\`\n` +
        `*Tentativas:* ${attempts}\n` +
        `*Erro:* ${error ?? "desconhecido"}\n\n` +
        (durable
          ? `A cópia está em \`webhook_outbox\` com status \`dead\` — dá para reentregar na mão.`
          : `*Sem cópia durável.* O conteúdo só existe no log do container.`),
      { critical: true },
    );
  }

  webhookBacklog({ queued, messages, receipts, inFlight }) {
    this.#fire(
      "webhook_backlog",
      { event: "webhook_backlog", queued, messages, receipts, inFlight },
      `⚠️ *Fila do webhook acumulando*\n\n` +
        `*Na fila:* ${queued} (${messages} mensagens, ${receipts} recibos)\n` +
        `*Em voo:* ${inFlight}\n\n` +
        `Rajada de recibo é o padrão conhecido: mensagem de usuário tem ` +
        `prioridade, mas fila longa ainda atrasa resposta.`,
    );
  }

  webhookShed({ reason, dropped, cap, shedTotal }) {
    this.#fire(
      `webhook_shed:${reason}`,
      { event: "webhook_receipts_shed", reason, dropped, cap, shedTotal },
      `⚠️ *Recibos de entrega descartados*\n\n` +
        `*Motivo:* ${reason}\n` +
        `*Descartados na janela:* ${shedTotal}\n\n` +
        `Recibo perdido cega a sentinela de entrega — ela conta ` +
        `\`status='failed'\` e lê verde por ausência de dado.`,
    );
  }

  #prune(list) {
    const cutoff = this.now() - this.windowMs;
    return list.filter((ts) => ts > cutoff);
  }

  #fire(key, logFields, message, { critical = false } = {}) {
    const now = this.now();
    // `has` e não `?? 0`: com um relógio que começa perto de zero (teste, ou um
    // processo que usa tempo monotônico), "nunca disparou" e "disparou agora"
    // ficariam indistinguíveis e o PRIMEIRO alerta seria engolido — o pior
    // silêncio possível num alarme.
    const seen = this.#cooldowns.has(key);
    const last = this.#cooldowns.get(key);

    // Crítico ignora cooldown de OUTROS eventos, mas não o próprio: repetir a
    // mesma perda de sessão a cada 5 min não informa nada de novo.
    if (seen && now - last < this.cooldownMs) {
      logger.info(
        { ...logFields, suppressed: true },
        "Alerta suprimido por cooldown",
      );
      return false;
    }

    this.#cooldowns.set(key, now);
    logger[critical ? "error" : "warn"](logFields, message.split("\n")[0]);

    this.#notifier?.notify?.(message)?.catch?.((error) => {
      logger.error(
        { error: error?.message, ...logFields },
        "Falha ao entregar alerta",
      );
    });

    return true;
  }

  snapshot() {
    return {
      disconnectsInWindow: this.#prune(this.#disconnects).length,
      sendFailuresInWindow: this.#prune(this.#sendFailures).length,
      sendsInWindow: this.#prune(this.#sendTotal).length,
      undeliveredInWindow: this.#prune(this.#undelivered).length,
      webhookDeferralsInWindow: this.#prune(this.#webhookDeferrals).length,
    };
  }
}
