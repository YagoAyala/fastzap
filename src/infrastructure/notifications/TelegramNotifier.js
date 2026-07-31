import axios from "axios";
import pino from "pino";
import { env } from "../../config/env.js";

const logger = pino({ level: "info" }).child({ module: "TelegramNotifier" });

export class TelegramNotifier {
  #token;
  #chatId;
  #enabled;

  constructor() {
    this.#token = env.TELEGRAM_TOKEN;
    this.#chatId = env.TELEGRAM_CHAT_ID;
    this.#enabled = Boolean(this.#token && this.#chatId);

    if (!this.#enabled) {
      logger.warn(
        "TelegramNotifier desabilitado: TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurados",
      );
    }
  }

  async notifySessionLost(sessionId, reason) {
    const message =
      `*[WhatsApp API]* Sessão perdida\n\n` +
      `*Sessão:* \`${sessionId}\`\n` +
      `*Motivo:* ${reason}\n` +
      `*Data:* ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;

    await this.#send(message);
  }

  async notifySessionRestored(sessionId) {
    const message =
      `*[WhatsApp API]* Sessão restaurada\n\n` +
      `*Sessão:* \`${sessionId}\`\n` +
      `*Data:* ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;

    await this.#send(message);
  }

  /** Alerta genérico — usado pelo vigia de saúde da sessão. */
  async notify(text) {
    await this.#send(text);
  }

  async #send(text) {
    if (!this.#enabled) return;

    const url = `https://api.telegram.org/bot${this.#token}/sendMessage`;

    try {
      await axios.post(url, {
        chat_id: this.#chatId,
        text,
        parse_mode: "Markdown",
      });
    } catch (err) {
      logger.error({ err }, "Falha ao enviar alerta para o Telegram");
    }
  }
}
