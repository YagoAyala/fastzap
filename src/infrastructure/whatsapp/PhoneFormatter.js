// Cache de JID canônico. onWhatsApp() é ida-e-volta na rede; sem cache cada
// envio pagaria esse custo.
const canonicalJidCache = new Map();

export class PhoneFormatter {
  static toJid(phone) {
    const digits = phone.replace(/\D/g, "");
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * JID canônico segundo o próprio WhatsApp, resolvido via onWhatsApp().
   *
   * O toJid() cru só cola o sufixo nos dígitos, e no Brasil isso perde mensagem
   * em silêncio: números registrados antes do 9º dígito têm JID canônico SEM o 9
   * (5547992512269 → 554792512269). Enviar pro JID errado não dá erro — o
   * relayMessage aceita, devolve messageId, e a mensagem simplesmente não chega.
   * Custou meia hora de diagnóstico em 31/07/2026 e, em produção, seriam
   * mensagens perdidas invisíveis para metade de uma base brasileira.
   *
   * Falha fechada no formato cru: se o WhatsApp não responder, é melhor tentar
   * enviar do que não enviar.
   */
  static async toCanonicalJid(phone, client) {
    const digits = String(phone).replace(/\D/g, "");
    if (!digits) return PhoneFormatter.toJid(phone);

    const cached = canonicalJidCache.get(digits);
    if (cached) return cached;

    try {
      const [result] = (await client?.onWhatsApp?.(digits)) ?? [];

      if (result?.exists && result.jid) {
        canonicalJidCache.set(digits, result.jid);
        return result.jid;
      }
      if (result?.exists && result.phone) {
        const jid = PhoneFormatter.toJid(result.phone);
        canonicalJidCache.set(digits, jid);
        return jid;
      }
    } catch {
      // rede/sessão instável — cai no formato cru abaixo
    }

    return PhoneFormatter.toJid(digits);
  }

  static toGroupJid(jid) {
    return jid.includes("@") ? jid : `${jid}@g.us`;
  }

  static fromJid(jid) {
    return jid.split("@")[0];
  }

  static isGroup(jid) {
    return jid.endsWith("@g.us");
  }
}
