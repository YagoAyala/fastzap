import {
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
} from "@whiskeysockets/baileys";

export class MediaDownloader {
  static MEDIA_TYPES = new Set([
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
  ]);

  /**
   * O gate precisa concordar com o downloader — e a única forma de garantir isso
   * é usar as MESMAS funções que o `downloadMediaMessage` usa por dentro.
   *
   * A versão anterior olhava `Object.keys(message.message)[0]`, e errava de duas
   * maneiras, as duas silenciosas (retornava `null`, indistinguível de "o
   * download falhou"):
   *
   * 1) ENVELOPE. Documento COM legenda chega como `documentWithCaptionMessage`,
   *    e mensagem de chat temporário como `ephemeralMessage`. Nenhum dos dois
   *    está em MEDIA_TYPES, então o gate barrava antes de tentar — mesmo o
   *    Baileys sabendo desembrulhar sozinho. Foi assim que o PDF de 31/07/2026
   *    chegou na Focca com `_baileysMedia: null` e o agente respondeu "o que
   *    acha do quê?".
   *
   * 2) PRIMEIRA CHAVE. O conteúdo carrega `messageContextInfo` junto da mídia
   *    com frequência, e ele pode vir primeiro — aí a imagem também seria
   *    descartada. Verificado no objeto real: `Object.keys()[0]` devolve
   *    "messageContextInfo" enquanto `getContentType()` devolve "imageMessage".
   */
  static hasMedia(message) {
    if (!message?.message) return false;

    const content = extractMessageContent(message.message);
    if (!content) return false;

    const contentType = getContentType(content);
    if (contentType && MediaDownloader.MEDIA_TYPES.has(contentType)) return true;

    // Rede de segurança: se um envelope novo aparecer e o getContentType não o
    // reconhecer, uma chave de mídia presente ainda vale a tentativa.
    return Object.keys(content).some((key) =>
      MediaDownloader.MEDIA_TYPES.has(key),
    );
  }

  /**
   * `logger` é opcional de propósito — quem chamar sem ele continua funcionando.
   * O que não pode voltar é o `catch {}` mudo: sem log, falha de download vira
   * `null` e some, e foi exatamente por isso que o documento quebrado só
   * apareceu quando um usuário reclamou.
   */
  async downloadAsBase64(message, socket, logger = null) {
    try {
      const buffer = await downloadMediaMessage(
        message,
        "buffer",
        {},
        {
          logger: socket.logger,
          reuploadRequest: socket.updateMediaMessage,
        },
      );

      return buffer.toString("base64");
    } catch (error) {
      logger?.error?.(
        {
          module: "MediaDownloader",
          err: { message: error?.message, stack: error?.stack },
          messageId: message?.key?.id ?? null,
          contentType: getContentType(
            extractMessageContent(message?.message) ?? {},
          ),
        },
        "Falha ao baixar mídia",
      );
      return null;
    }
  }
}
