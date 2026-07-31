import { SessionNotFoundError } from "../../domain/errors/index.js";
import { PhoneFormatter } from "../../infrastructure/whatsapp/PhoneFormatter.js";

export class SendGroupMessageUseCase {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  async execute({ sessionId, jid, message, lane }) {
    const client = this.sessionManager.getClient(sessionId);

    if (!client) {
      throw new SessionNotFoundError(sessionId);
    }

    const groupJid = PhoneFormatter.toGroupJid(jid);

    // Todo outro use case envolve o texto em { text: ... }; aqui ia a string
    // crua, e o Baileys estoura com "Cannot use 'in' operator to search for
    // 'image' in <texto>" — ou seja, TODO envio de texto pra grupo dava 500.
    // Grupo "voltou a funcionar" só nos botões; o texto nunca chegou a sair.
    const result = await client.sendMessage(groupJid, { text: message }, { lane });

    const messageId = result?.key?.id ?? result?.key?.id ?? "";

    return { messageId, id: messageId };
  }
}
