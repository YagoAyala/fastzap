import { SendMessageUseCase } from "../../../application/chat/SendMessageUseCase.js";
import { SendBulkMessageUseCase } from "../../../application/chat/SendBulkMessageUseCase.js";
import { SendButtonsUseCase } from "../../../application/chat/SendButtonsUseCase.js";
import {
  sendTextSchema,
  sendImageSchema,
  sendAudioSchema,
  sendVideoSchema,
  sendDocumentSchema,
  sendLinkSchema,
  sendLocationSchema,
  sendContactSchema,
  sendReactionSchema,
  sendBulkSchema,
  sendButtonsSchema,
} from "../schemas/message.schema.js";

export async function messageRoutes(app, { sessionManager }) {
  const sendUseCase = new SendMessageUseCase(sessionManager);
  const sendBulkUseCase = new SendBulkMessageUseCase(sessionManager);
  const sendButtonsUseCase = new SendButtonsUseCase(sessionManager, app.log);

  app.post("/send-presence", async (req, reply) => {
    const { phone, presence = "composing" } = req.body ?? {};
    const client = sessionManager.getClient(req.query.id);
    if (!client) return reply.status(404).send({ error: "sessão não encontrada" });

    const { PhoneFormatter } = await import(
      "../../whatsapp/PhoneFormatter.js"
    );
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);
    await client.sendPresence(jid, presence);
    return reply.send({ success: true });
  });

  app.post("/read-message", async (req, reply) => {
    const { phone, messageId } = req.body ?? {};
    const client = sessionManager.getClient(req.query.id);
    if (!client) return reply.status(404).send({ error: "sessão não encontrada" });

    const { PhoneFormatter } = await import(
      "../../whatsapp/PhoneFormatter.js"
    );
    const jid = await PhoneFormatter.toCanonicalJid(phone, client);
    await client.readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]);
    return reply.send({ success: true });
  });

  app.post("/send-buttons", { schema: sendButtonsSchema }, async (req, reply) => {
    const { phone, text, footer, buttons, strategies, lane } = req.body;

    const result = await sendButtonsUseCase.execute({
      sessionId: req.query.id,
      phone,
      text,
      footer,
      buttons,
      lane,
      ...(strategies && { strategies }),
    });

    return reply.send(result);
  });

  app.post("/send-text", { schema: sendTextSchema }, async (req, reply) => {
    const { phone, message, lane } = req.body;

    const result = await sendUseCase.sendText({
      sessionId: req.query.id,
      phone,
      message,
      // Sem lane declarada, o default é `proactive`: falhar pro lado seguro é o
      // certo aqui — tratar proativa como reativa é o erro caro.
      lane,
    });

    return reply.send(result);
  });

  app.post("/send-image", { schema: sendImageSchema }, async (req, reply) => {
    const { phone, image, caption, viewOnce } = req.body;

    const result = await sendUseCase.sendImage({
      sessionId: req.query.id,
      phone,
      image,
      caption,
      viewOnce,
    });

    return reply.send(result);
  });

  app.post("/send-audio", { schema: sendAudioSchema }, async (req, reply) => {
    const { phone, audio, ptt } = req.body;

    const result = await sendUseCase.sendAudio({
      sessionId: req.query.id,
      phone,
      audio,
      ptt,
    });

    return reply.send(result);
  });

  app.post("/send-video", { schema: sendVideoSchema }, async (req, reply) => {
    const { phone, video, caption, viewOnce } = req.body;

    const result = await sendUseCase.sendVideo({
      sessionId: req.query.id,
      phone,
      video,
      caption,
      viewOnce,
    });

    return reply.send(result);
  });

  app.post(
    "/send-document",
    { schema: sendDocumentSchema },
    async (req, reply) => {
      const { phone, document, fileName, caption } = req.body;

      const result = await sendUseCase.sendDocument({
        sessionId: req.query.id,
        phone,
        document,
        fileName,
        caption,
      });

      return reply.send(result);
    },
  );

  app.post("/send-link", { schema: sendLinkSchema }, async (req, reply) => {
    const { phone, message, linkUrl, title, linkDescription, image } = req.body;

    const result = await sendUseCase.sendLink({
      sessionId: req.query.id,
      phone,
      message,
      linkUrl,
      title,
      linkDescription,
      image,
    });

    return reply.send(result);
  });

  app.post(
    "/send-location",
    { schema: sendLocationSchema },
    async (req, reply) => {
      const { phone, lat, lng, address } = req.body;

      const result = await sendUseCase.sendLocation({
        sessionId: req.query.id,
        phone,
        lat,
        lng,
        address,
      });

      return reply.send(result);
    },
  );

  app.post(
    "/send-contact",
    { schema: sendContactSchema },
    async (req, reply) => {
      const { phone, contactName, contactPhone } = req.body;

      const result = await sendUseCase.sendContact({
        sessionId: req.query.id,
        phone,
        contactName,
        contactPhone,
      });

      return reply.send(result);
    },
  );

  app.post(
    "/send-reaction",
    { schema: sendReactionSchema },
    async (req, reply) => {
      const { phone, messageId, reaction } = req.body;

      const result = await sendUseCase.sendReaction({
        sessionId: req.query.id,
        phone,
        messageId,
        reaction,
      });

      return reply.send(result);
    },
  );

  app.post("/send-bulk", { schema: sendBulkSchema }, async (req, reply) => {
    const result = await sendBulkUseCase.execute({
      sessionId: req.query.id,
      items: req.body,
    });

    return reply.send(result);
  });
}
