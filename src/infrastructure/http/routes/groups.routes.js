import { GetGroupsUseCase } from "../../../application/group/GetGroupsUseCase.js";
import { GetGroupMetaUseCase } from "../../../application/group/GetGroupMetaUseCase.js";
import { SendGroupMessageUseCase } from "../../../application/group/SendGroupMessageUseCase.js";
import { GetChatMessagesUseCase } from "../../../application/chat/GetChatMessagesUseCase.js";
import {
  listGroupsSchema,
  groupMetaSchema,
  sendGroupMessageSchema,
  groupMessagesSchema,
} from "../schemas/group.schema.js";

export async function groupRoutes(
  app,
  { sessionManager, chatRepository, messageRepository },
) {
  const getGroups = new GetGroupsUseCase(sessionManager, chatRepository);
  const getGroupMeta = new GetGroupMetaUseCase(sessionManager);
  const sendGroupMessage = new SendGroupMessageUseCase(sessionManager);
  const getMessages = new GetChatMessagesUseCase(
    sessionManager,
    messageRepository,
  );

  app.get("/", { schema: listGroupsSchema }, async (req, reply) => {
    const groups = await getGroups.execute(req.query.id);

    return reply.send({
      success: true,
      message: "Grupos listados com sucesso",
      data: groups,
    });
  });

  app.get("/:jid/meta", { schema: groupMetaSchema }, async (req, reply) => {
    const meta = await getGroupMeta.execute({
      sessionId: req.query.id,
      jid: req.params.jid,
    });

    return reply.send({
      success: true,
      message: "Metadados do grupo obtidos com sucesso",
      data: meta,
    });
  });

  app.post("/send", { schema: sendGroupMessageSchema }, async (req, reply) => {
    const { phone, message, lane } = req.body;

    const result = await sendGroupMessage.execute({
      sessionId: req.query.id,
      jid: phone,
      message,
      // Sem repassar, resposta em grupo entrava como contato frio e um grupo
      // movimentado emudecia ao bater 20 mensagens no dia.
      lane,
    });

    return reply.send(result);
  });

  app.get(
    "/:jid/messages",
    { schema: groupMessagesSchema },
    async (req, reply) => {
      const { limit, cursor_id, cursor_from_me } = req.query;

      const messages = await getMessages.execute({
        sessionId: req.query.id,
        jid: req.params.jid,
        limit: limit ? Number(limit) : 25,
        cursorId: cursor_id ?? null,
        cursorFromMe:
          cursor_from_me !== undefined ? cursor_from_me === "true" : null,
      });

      return reply.send({
        success: true,
        message: "Mensagens do grupo obtidas com sucesso",
        data: messages,
      });
    },
  );
}
