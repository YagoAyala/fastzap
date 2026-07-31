import { SessionNotFoundError } from "../../domain/errors/index.js";
import { PhoneFormatter } from "../../infrastructure/whatsapp/PhoneFormatter.js";

export class SendMessageUseCase {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  async sendText({ sessionId, phone, message, lane, quotedId }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    // `quoted` precisa de uma mensagem com key + message. Um stub com o id basta
    // pro WhatsApp resolver a citação do lado do cliente — não é necessário ter
    // o conteúdo original guardado.
    const quoted = quotedId
      ? { key: { remoteJid: jid, id: quotedId, fromMe: false }, message: {} }
      : undefined;

    const result = await client.sendMessage(
      jid,
      { text: message },
      { lane, quoted }
    );

    return this._formatResult(result);
  }

  async sendImage({ sessionId, phone, image, caption = "", viewOnce = false, lane }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const content = {
      image: image.startsWith("data:")
        ? Buffer.from(image.split(",")[1], "base64")
        : { url: image },
      caption,
      viewOnce,
    };

    const result = await client.sendMessage(jid, content, { lane });

    return this._formatResult(result);
  }

  async sendAudio({ sessionId, phone, audio, ptt = true, lane }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const content = {
      audio: audio.startsWith("data:")
        ? Buffer.from(audio.split(",")[1], "base64")
        : { url: audio },
      ptt,
      mimetype: "audio/ogg; codecs=opus",
    };

    const result = await client.sendMessage(jid, content, { lane });

    return this._formatResult(result);
  }

  async sendVideo({ sessionId, phone, video, caption = "", viewOnce = false, lane }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const content = {
      video: video.startsWith("data:")
        ? Buffer.from(video.split(",")[1], "base64")
        : { url: video },
      caption,
      viewOnce,
    };

    const result = await client.sendMessage(jid, content, { lane });

    return this._formatResult(result);
  }

  async sendDocument({ sessionId, phone, document, fileName, caption = "", lane }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const content = {
      document: document.startsWith("data:")
        ? Buffer.from(document.split(",")[1], "base64")
        : { url: document },
      fileName,
      caption,
      mimetype: this._getMimeFromFileName(fileName),
    };

    const result = await client.sendMessage(jid, content, { lane });

    return this._formatResult(result);
  }

  async sendLink({
    sessionId,
    phone,
    message,
    linkUrl,
    title,
    linkDescription,
    image,
    lane,
  }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const content = {
      text: `${message}\n${linkUrl}`,
      contextInfo: {
        externalAdReply: {
          title: title ?? linkUrl,
          body: linkDescription ?? "",
          mediaUrl: linkUrl,
          sourceUrl: linkUrl,
          ...(image && { thumbnailUrl: image, renderLargerThumbnail: true }),
        },
      },
    };

    const result = await client.sendMessage(jid, content, { lane });

    return this._formatResult(result);
  }

  async sendLocation({ sessionId, phone, lat, lng, address, lane }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const result = await client.sendMessage(jid, {
      location: {
        degreesLatitude: lat,
        degreesLongitude: lng,
        name: address ?? "",
      },
    }, { lane });

    return this._formatResult(result);
  }

  async sendContact({ sessionId, phone, contactName, contactPhone, lane }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    const vcard =
      `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\n` +
      `TEL;type=CELL;type=VOICE;waid=${contactPhone.replace(/\D/g, "")}:+${contactPhone.replace(/\D/g, "")}\n` +
      `END:VCARD`;

    const result = await client.sendMessage(jid, {
      contacts: {
        displayName: contactName,
        contacts: [{ vcard }],
      },
    }, { lane });

    return this._formatResult(result);
  }

  async sendReaction({ sessionId, phone, messageId, reaction }) {
    const client = this._getClient(sessionId);
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);

    // Reativa por CONSTRUÇÃO, não por declaração do chamador: só existe reação
    // a uma mensagem que já está na conversa, então nunca é contato frio. Cair no
    // default `proactive` fazia o recibo 👀 consumir o cap de 20/dia e depois ser
    // recusado por ele — verificado em produção em 31/07/2026.
    const result = await client.sendMessage(jid, {
      react: { text: reaction, key: { remoteJid: jid, id: messageId } },
    }, { lane: "reactive" });

    return this._formatResult(result);
  }

  _getClient(sessionId) {
    const client = this.sessionManager.getClient(sessionId);

    if (!client) throw new SessionNotFoundError(sessionId);

    return client;
  }

  _formatResult(result) {
    const messageId = result?.key?.id ?? result?.messageID ?? null;

    return { messageId, id: messageId };
  }

  _getMimeFromFileName(fileName) {
    const ext = fileName.split(".").pop()?.toLowerCase();

    const mimeMap = {
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      zip: "application/zip",
      txt: "text/plain",
      csv: "text/csv",
      mp4: "video/mp4",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
    };

    return mimeMap[ext] ?? "application/octet-stream";
  }
}
