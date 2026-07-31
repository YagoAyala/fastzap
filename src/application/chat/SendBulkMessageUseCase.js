import { SessionNotFoundError } from "../../domain/errors/index.js";
import { PhoneFormatter } from "../../infrastructure/whatsapp/PhoneFormatter.js";

export class SendBulkMessageUseCase {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  async execute({ sessionId, items }) {
    const client = this.sessionManager.getClient(sessionId);

    if (!client) {
      throw new SessionNotFoundError(sessionId);
    }

    let sent = 0;
    let failed = 0;
    const failedItems = [];

    for (let i = 0; i < items.length; i++) {
      const { phone, message } = items[i];

      try {
        const jid = await PhoneFormatter.toCanonicalJid(phone, client);
        await client.sendMessage(jid, { text: message });
        sent++;
      } catch {
        failed++;
        failedItems.push(i);
      }
    }

    return { sent, failed, failedItems };
  }
}
