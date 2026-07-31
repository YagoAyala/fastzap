import axios from "axios";
import pino from "pino";
import { env } from "../../config/env.js";
import { MediaDownloader } from "../whatsapp/MediaDownloader.js";

const logger = pino({ level: "info" }).child({ module: "WebhookDispatcher" });

// O JID carrega domínio E, em multi-device, o índice do aparelho:
// "554792512269:0@s.whatsapp.net". Deixar o ":0" passar é tão quebrado quanto
// deixar o "@lid": quem indexa usuário por telefone não casa "554792512269:0"
// com "554792512269". Tira os dois.
const stripJidSuffixes = (jid) =>
  String(jid || "")
    .replace(/@(s\.whatsapp\.net|g\.us|c\.us|lid)$/, "")
    .replace(/:\d+$/, "");

export class WebhookDispatcher {
  #webhookUrl;
  #maxRetries;
  #retryDelayMs;
  #mediaDownloader;
  #enabled;
  #sessionManager;

  constructor(sessionManager) {
    this.#webhookUrl = env.WEBHOOK_URL;
    this.#maxRetries = env.WEBHOOK_MAX_RETRIES;
    this.#retryDelayMs = env.WEBHOOK_RETRY_DELAY_MS;
    this.#mediaDownloader = new MediaDownloader();
    this.#enabled = Boolean(this.#webhookUrl);
    this.#sessionManager = sessionManager;

    if (!this.#enabled) {
      logger.warn(
        "WebhookDispatcher desabilitado: WEBHOOK_URL não configurado",
      );
      return;
    }

    sessionManager.onMessage((message, sessionId) => {
      this.#dispatch(message, sessionId).catch((err) =>
        logger.error({ err, sessionId }, "Erro fatal no dispatch de webhook"),
      );
    });

    // Recibos de entrega num envelope PRÓPRIO. Quem consome distingue pelo
    // `type` e não precisa adivinhar: ReceivedCallback é mensagem de usuário,
    // MessageStatusCallback é o WhatsApp dizendo o que aconteceu com o que
    // mandamos. Sem isso, "entregou" e "sumiu" são indistinguíveis.
    sessionManager.onMessageStatus?.((status, sessionId) => {
      this.#sendWithRetry({
        instanceId: sessionId,
        type: "MessageStatusCallback",
        phone: stripJidSuffixes(status.jid),
        messageId: status.messageId,
        status: status.status,
        fromMe: status.fromMe,
        momment: Date.now(),
      }).catch((err) =>
        logger.error({ err, sessionId }, "Erro no dispatch de status"),
      );
    });

    logger.info({ url: this.#webhookUrl }, "WebhookDispatcher ativo");
  }

  async #dispatch(message, sessionId) {
    const payload = await this.#buildPayload(message, sessionId);
    await this.#sendWithRetry(payload);
  }

  async #buildPayload(msg, sessionId) {
    const key = msg.key ?? {};
    const rawJid = key.remoteJid ?? "";
    const isGroup = rawJid.endsWith("@g.us");
    const fromMe = key.fromMe ?? false;

    const phone = await this.#resolvePhone(rawJid, sessionId);

    const momment =
      typeof msg.messageTimestamp === "object"
        ? Number(msg.messageTimestamp) * 1000
        : (msg.messageTimestamp ?? 0) * 1000;

    const msgContent = msg.message ?? {};

    const { type, typePayload } = await this.#extractTypePayload(
      msg,
      msgContent,
      sessionId,
    );

    // Em grupo, `phone` é o JID do GRUPO — quem falou está em key.participant.
    // Sem isso o consumidor não tem como saber de quem creditar a mensagem, e
    // trataria o grupo inteiro como se fosse um contato só.
    const participantPhone = isGroup
      ? await this.#resolvePhone(key.participant ?? "", sessionId)
      : phone;

    return {
      instanceId: sessionId,
      phone,
      participantPhone,
      chatName: msg.pushName ?? null,
      fromMe,
      isGroup,
      type: "ReceivedCallback",
      momment,
      messageId: key.id ?? null,
      ...typePayload,
    };
  }

  /**
   * Desembrulha envelopes que só existem pra carregar outra mensagem.
   *
   * Quem tem "mensagens temporárias" ligado no WhatsApp manda TUDO dentro de
   * ephemeralMessage; view-once idem. Sem desembrulhar, nenhum dos `if` de tipo
   * casava, caía em `unknown` e o webhook respondia 200 IGNORED — ou seja, essa
   * pessoa não recebia resposta pra absolutamente nada, sem erro em lugar
   * nenhum. Aninhamento é possível (viewOnce dentro de ephemeral), então
   * desembrulha em laço, com teto pra não girar em payload malformado.
   */
  #unwrapEnvelopes(msgContent) {
    let content = msgContent;
    for (let depth = 0; depth < 4; depth += 1) {
      const inner =
        content?.ephemeralMessage?.message ??
        content?.viewOnceMessage?.message ??
        content?.viewOnceMessageV2?.message ??
        content?.viewOnceMessageV2Extension?.message ??
        content?.documentWithCaptionMessage?.message ??
        content?.editedMessage?.message;
      if (!inner) break;
      content = inner;
    }
    return content;
  }

  async #extractTypePayload(msg, rawContent, sessionId) {
    const msgContent = this.#unwrapEnvelopes(rawContent);
    // Resposta de opção clicada. Precisa vir ANTES do bloco de texto: o
    // buttonsResponseMessage também carrega o rótulo em texto, e sem isso a
    // escolha chegaria como mensagem comum — o chamador perderia o `id` e não
    // saberia qual opção o usuário tocou.
    const choice = this.#extractChoice(msgContent);
    if (choice) {
      return {
        type: "buttonsResponse",
        typePayload: {
          buttonsResponse: choice,
          // Espelhado como texto para quem só trata `text` continuar funcionando.
          text: { message: choice.title ?? choice.id ?? "" },
        },
      };
    }

    if (msgContent.conversation || msgContent.extendedTextMessage) {
      const text =
        msgContent.conversation ?? msgContent.extendedTextMessage?.text ?? "";

      return {
        type: "text",
        typePayload: {
          text: { message: text },
        },
      };
    }

    if (msgContent.imageMessage) {
      const im = msgContent.imageMessage;
      const imageUrl = await this.#tryDownloadMedia(msg, sessionId);

      return {
        type: "image",
        typePayload: {
          image: {
            imageUrl: im.url ?? null,
            caption: im.caption ?? null,
            base64: imageUrl,
            mimeType: im.mimetype ?? null,
          },
        },
      };
    }

    if (msgContent.audioMessage) {
      const am = msgContent.audioMessage;
      const base64 = await this.#tryDownloadMedia(msg, sessionId);

      return {
        type: am.ptt ? "ptt" : "audio",
        typePayload: {
          audio: {
            audioUrl: am.url ?? null,
            base64,
            mimeType: am.mimetype ?? null,
            ptt: am.ptt ?? false,
            seconds: am.seconds ?? null,
          },
        },
      };
    }

    if (msgContent.videoMessage) {
      const vm = msgContent.videoMessage;
      const base64 = await this.#tryDownloadMedia(msg, sessionId);

      return {
        type: "video",
        typePayload: {
          video: {
            videoUrl: vm.url ?? null,
            caption: vm.caption ?? null,
            base64,
            mimeType: vm.mimetype ?? null,
            seconds: vm.seconds ?? null,
          },
        },
      };
    }

    if (msgContent.documentMessage) {
      const dm = msgContent.documentMessage;
      const base64 = await this.#tryDownloadMedia(msg, sessionId);

      return {
        type: "document",
        typePayload: {
          document: {
            documentUrl: dm.url ?? null,
            fileName: dm.fileName ?? null,
            caption: dm.caption ?? null,
            base64,
            mimeType: dm.mimetype ?? null,
          },
        },
      };
    }

    if (msgContent.locationMessage) {
      const lm = msgContent.locationMessage;

      return {
        type: "location",
        typePayload: {
          location: {
            latitude: lm.degreesLatitude ?? null,
            longitude: lm.degreesLongitude ?? null,
            address: lm.name ?? null,
          },
        },
      };
    }

    if (msgContent.contactMessage) {
      const cm = msgContent.contactMessage;

      return {
        type: "contact",
        typePayload: {
          contact: {
            displayName: cm.displayName ?? null,
            vcard: cm.vcard ?? null,
          },
        },
      };
    }

    if (msgContent.reactionMessage) {
      const rm = msgContent.reactionMessage;

      return {
        type: "reaction",
        typePayload: {
          reaction: {
            value: rm.text ?? null,
            reactionMessageId: rm.key?.id ?? null,
          },
        },
      };
    }

    if (msgContent.stickerMessage) {
      const sm = msgContent.stickerMessage;
      const base64 = await this.#tryDownloadMedia(msg, sessionId);

      return {
        type: "sticker",
        typePayload: {
          sticker: {
            stickerUrl: sm.url ?? null,
            base64,
            mimeType: sm.mimetype ?? null,
          },
        },
      };
    }

    return {
      type: "unknown",
      typePayload: { raw: msgContent },
    };
  }

  /**
   * Devolve o telefone real do remetente.
   *
   * O WhatsApp passou a endereçar parte dos contatos por LID (`<id>@lid`) em vez
   * do telefone. O replace anterior só tirava @s.whatsapp.net/@g.us/@c.us, então
   * o LID vazava inteiro pro webhook — como visto no teste de 31/07/2026, que
   * voltou `phone: "244486919729190@lid"`. Pra qualquer consumidor que indexe
   * usuário por telefone (o caso da Focca), isso transforma cada mensagem num
   * contato desconhecido.
   *
   * O Baileys mantém o mapa: signalRepository.lidMapping.getPNForLID(). Se a
   * resolução falhar devolvemos o id sem sufixo — melhor um id estável do que
   * uma string com "@lid" grudado.
   */
  async #resolvePhone(rawJid, sessionId) {
    if (!rawJid.endsWith("@lid")) return stripJidSuffixes(rawJid);

    try {
      const socket = this.#sessionManager?.getClient(sessionId)?.socket;
      const pn = await socket?.signalRepository?.lidMapping?.getPNForLID(rawJid);

      if (pn) return stripJidSuffixes(String(pn));
    } catch (error) {
      logger.warn(
        { sessionId, rawJid, error: error?.message },
        "Falha ao resolver LID para telefone",
      );
    }

    return stripJidSuffixes(rawJid);
  }

  /**
   * Normaliza o toque numa opção, venha ela de qual estratégia for.
   *
   * O SendButtonsUseCase degrada em cascata (interactive → buttons → list →
   * poll → texto), então a resposta chega em quatro formatos diferentes de
   * proto. Quem consome o webhook não deveria precisar saber qual venceu — sai
   * sempre `{ id, title, source }`.
   *
   * Não cobre a enquete: voto de poll não vem no messages.upsert, vem em
   * messages.update com o voto criptografado, e precisa da mensagem original pra
   * decifrar (getAggregateVotesInPollMessage). Fica como peça separada.
   */
  #extractChoice(msgContent) {
    const buttons = msgContent.buttonsResponseMessage;
    if (buttons) {
      return {
        id: buttons.selectedButtonId ?? null,
        title: buttons.selectedDisplayText ?? null,
        source: "buttons",
      };
    }

    const template = msgContent.templateButtonReplyMessage;
    if (template) {
      return {
        id: template.selectedId ?? null,
        title: template.selectedDisplayText ?? null,
        source: "template",
      };
    }

    const list = msgContent.listResponseMessage;
    if (list) {
      return {
        id: list.singleSelectReply?.selectedRowId ?? null,
        title: list.title ?? null,
        source: "list",
      };
    }

    const interactive = msgContent.interactiveResponseMessage;
    if (interactive) {
      // O nativeFlow devolve os dados como JSON dentro de paramsJson.
      const raw = interactive.nativeFlowResponseMessage?.paramsJson;
      let parsed = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }

      return {
        id: parsed.id ?? parsed.selectedId ?? null,
        title:
          parsed.display_text ??
          interactive.body?.text ??
          null,
        source: "interactive",
      };
    }

    return null;
  }

  async #tryDownloadMedia(message, sessionId) {
    try {
      if (!MediaDownloader.hasMedia(message)) return null;

      const client = this.#sessionManager?.getClient(sessionId);

      if (!client?.socket) return null;

      return await this.#mediaDownloader.downloadAsBase64(
        message,
        client.socket,
      );
    } catch {
      return null;
    }
  }

  async #sendWithRetry(payload) {
    let lastError;

    for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
      try {
        await axios.post(this.#webhookUrl, payload, {
          headers: {
            "Content-Type": "application/json",
            // Sem isto o destino não tem como distinguir o gateway de qualquer
            // um que descubra a URL: o webhook não é assinado como o da Meta.
            // Opcional — quem não configurar segue como antes.
            ...(env.WEBHOOK_HEADER_SECRET && {
              "x-gateway-secret": env.WEBHOOK_HEADER_SECRET,
            }),
          },
          timeout: 10_000,
        });

        return; // sucesso
      } catch (err) {
        lastError = err;

        if (attempt < this.#maxRetries) {
          const delay = this.#retryDelayMs * Math.pow(2, attempt - 1);
          logger.warn(
            { attempt, maxRetries: this.#maxRetries, delayMs: delay },
            "Falha no webhook, tentando novamente",
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      { err: lastError, attempts: this.#maxRetries },
      "Webhook falhou após todas as tentativas",
    );
  }
}
