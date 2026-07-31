import pino from "pino";

const logger = pino({ level: "info" }).child({ module: "OutboundQueue" });

/**
 * Fila única de saída, com duas faixas.
 *
 * O jitter que existia (`setTimeout` de 1-4s dentro de cada envio) é uma ilusão
 * de pacing: sem estado compartilhado, 10 requests simultâneos dormem em
 * PARALELO e disparam quase juntos. Um fan-out de 200 briefings virava ~200
 * stanzas em ~3s — a assinatura de spam bot mais clara que existe.
 *
 * Por que a fila mora AQUI e não na camada de use case: aqui é impossível
 * burlar. Se o pacing ficasse no use case, `sendRawMessage` (usado pelos botões)
 * escaparia.
 *
 * As duas faixas existem porque o risco é assimétrico:
 * - `reactive`  = responder quem acabou de escrever. É o tráfego que LEGITIMA o
 *   número, e atrasar resposta de assistente degrada o produto. Passa quase
 *   direto, com prioridade estrita.
 * - `proactive` = nós iniciando (briefing, lembrete, cobrança, campanha). É o
 *   que queima número. Paga o intervalo cheio.
 *
 * O intervalo é aleatório de propósito: um metrônomo de 1500ms exatos é tão
 * identificável quanto rajada nenhuma — a REGULARIDADE é a impressão digital.
 */
export class OutboundQueue {
  #queues = { reactive: [], proactive: [] };
  #draining = false;
  #lastSentAt = 0;
  #perRecipientDay = new Map();
  #dayKey = "";

  constructor({
    budget = null,
    reactiveMinIntervalMs = 250,
    reactiveJitterMs = 400,
    proactiveMinIntervalMs = 1500,
    proactiveJitterMs = 2500,
    perRecipientDailyLimit = 20,
    maxDepth = 5000,
  } = {}) {
    this.reactiveMinIntervalMs = reactiveMinIntervalMs;
    this.reactiveJitterMs = reactiveJitterMs;
    this.proactiveMinIntervalMs = proactiveMinIntervalMs;
    this.proactiveJitterMs = proactiveJitterMs;
    this.perRecipientDailyLimit = perRecipientDailyLimit;
    this.maxDepth = maxDepth;
    this.budget = budget;
  }

  /**
   * @param {() => Promise<any>} task envio real
   * @param {{lane?: 'reactive'|'proactive', jid?: string}} opts
   */
  enqueue(task, { lane = "proactive", jid = "" } = {}) {
    const queue = this.#queues[lane] ?? this.#queues.proactive;

    if (queue.length >= this.maxDepth) {
      // Descarta o proativo mais ANTIGO: uma mensagem represada há horas já
      // perdeu o sentido, a nova ainda tem.
      const dropped = queue.shift();
      dropped?.reject(new Error("Fila de saída cheia — mensagem antiga descartada"));
      logger.error({ lane, depth: queue.length }, "Fila de saída no limite");
    }

    return new Promise((resolve, reject) => {
      queue.push({ task, jid, lane, resolve, reject });
      this.#drain();
    });
  }

  /**
   * Cap por destinatário — a válvula que mais importa.
   *
   * Denúncia de usuário é a causa nº1 de banimento, muito acima de volume
   * total. O incidente realista não é "mandamos muito", é um loop martelando UM
   * número até a pessoa denunciar. Reativo é isento: se a pessoa está
   * escrevendo, responder não é assédio.
   */
  #withinRecipientBudget(entry) {
    // Com orçamento persistido, ele é a autoridade — o contador em memória
    // zerava a cada restart, que é justamente quando o limite mais importa.
    if (this.budget) {
      return this.budget.check({ lane: entry.lane, jid: entry.jid }).allowed;
    }

    if (entry.lane === "reactive" || !entry.jid) return true;

    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.#dayKey) {
      this.#dayKey = today;
      this.#perRecipientDay.clear();
    }

    const used = this.#perRecipientDay.get(entry.jid) ?? 0;
    return used < this.perRecipientDailyLimit;
  }

  #commitRecipient(entry) {
    // A faixa precisa ir junto: sem ela o orçamento persistido contava resposta
    // como se fosse contato frio, e o contador em memória logo abaixo (que
    // isenta reativo) discordava do persistido — que é o que manda.
    this.budget?.commit({ jid: entry.jid, lane: entry.lane });
    if (entry.lane === "reactive" || !entry.jid) return;
    this.#perRecipientDay.set(
      entry.jid,
      (this.#perRecipientDay.get(entry.jid) ?? 0) + 1
    );
  }

  #next() {
    // Prioridade estrita: deixar proativo passar fome é o comportamento
    // desejado, não um efeito colateral.
    return this.#queues.reactive.shift() ?? this.#queues.proactive.shift();
  }

  async #drain() {
    if (this.#draining) return;
    this.#draining = true;

    try {
      let entry;
      while ((entry = this.#next())) {
        if (!this.#withinRecipientBudget(entry)) {
          logger.warn(
            { jid: entry.jid, limit: this.perRecipientDailyLimit },
            "Cap diário por destinatário atingido — proativa recusada"
          );
          entry.reject(
            new Error("Limite diário de mensagens para este destinatário")
          );
          continue;
        }

        const isReactive = entry.lane === "reactive";
        const floor = isReactive
          ? this.reactiveMinIntervalMs
          : this.proactiveMinIntervalMs;
        const jitter = isReactive ? this.reactiveJitterMs : this.proactiveJitterMs;
        const gap = floor + Math.floor(Math.random() * jitter);
        const elapsed = Date.now() - this.#lastSentAt;

        if (elapsed < gap) {
          await new Promise((r) => setTimeout(r, gap - elapsed));
        }

        try {
          const result = await entry.task();
          this.#lastSentAt = Date.now();
          this.#commitRecipient(entry);
          entry.resolve(result);
        } catch (error) {
          this.#lastSentAt = Date.now();
          entry.reject(error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  stats() {
    return {
      depth: {
        reactive: this.#queues.reactive.length,
        proactive: this.#queues.proactive.length,
      },
      lastSentAt: this.#lastSentAt,
      trackedRecipients: this.#perRecipientDay.size,
    };
  }
}
