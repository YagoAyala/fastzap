import fp from "fastify-plugin";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

const SHARED_SCHEMAS = [
  {
    $id: "Session",
    type: "object",
    properties: {
      id: { type: "string", example: "minha-sessao" },
      status: {
        type: "string",
        enum: ["connecting", "qr_ready", "authenticated", "disconnected"],
        example: "authenticated",
      },
      phoneNumber: { type: "string", nullable: true, example: "5511999999999" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "SessionStatus",
    type: "object",
    properties: {
      connected: { type: "boolean", example: true },
      smartphoneConnected: { type: "boolean", example: true },
      error: { type: "string", nullable: true, example: null },
    },
  },
  {
    $id: "QrCode",
    type: "object",
    properties: {
      value: {
        type: "string",
        nullable: true,
        description: "QR code em base64 (data:image/png;base64,...)",
        example: "data:image/png;base64,iVBORw0KGgo...",
      },
      error: {
        type: "string",
        nullable: true,
        example: "QR code not available",
      },
    },
  },
  {
    // Este schema não é documentação: o fast-json-stringify serializa a resposta
    // POR ELE e APAGA todo campo que não estiver aqui. `/send-buttons` devolvia
    // `strategy` e `attempted` desde sempre e nenhum dos dois jamais chegou ao
    // consumidor — o aviso "o botão nativo degradou" era impossível de disparar
    // do outro lado. `nullable` no messageId pelo mesmo motivo: id ausente é um
    // fato que precisa TRAFEGAR, não virar string vazia.
    $id: "MessageSent",
    type: "object",
    properties: {
      messageId: { type: "string", nullable: true, example: "3EB0ABC123DEF" },
      id: { type: "string", nullable: true, example: "3EB0ABC123DEF" },
      strategy: {
        type: "string",
        nullable: true,
        description:
          "Estratégia que venceu a cascata de botões (interactive/buttons/list/poll/text).",
        example: "interactive",
      },
      attempted: {
        type: "array",
        description: "Estratégias que falharam antes, com o erro de cada uma.",
        items: {
          type: "object",
          properties: {
            strategy: { type: "string" },
            error: { type: "string" },
          },
        },
      },
    },
  },
  {
    $id: "BulkResult",
    type: "object",
    properties: {
      sent: { type: "integer", example: 5 },
      failed: { type: "integer", example: 1 },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            phone: { type: "string", example: "5511999999999" },
            success: { type: "boolean" },
            messageId: { type: "string", nullable: true },
            error: { type: "string", nullable: true },
          },
        },
      },
    },
  },
  {
    $id: "PhoneExists",
    type: "array",
    items: {
      type: "object",
      properties: {
        exists: { type: "boolean", example: true },
        phone: { type: "string", example: "5511999999999" },
        lid: { type: "string", nullable: true, example: null },
      },
    },
  },
  {
    $id: "Chat",
    type: "object",
    properties: {
      jid: { type: "string", example: "5511999999999@s.whatsapp.net" },
      name: { type: "string", nullable: true, example: "João Silva" },
      isGroup: { type: "boolean", example: false },
      lastMessageAt: { type: "string", format: "date-time", nullable: true },
    },
  },
  {
    $id: "Message",
    type: "object",
    properties: {
      id: { type: "string" },
      jid: { type: "string" },
      fromMe: { type: "boolean" },
      type: { type: "string", example: "text" },
      content: { type: "string", nullable: true },
      timestamp: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "Group",
    type: "object",
    properties: {
      jid: { type: "string", example: "123456789@g.us" },
      name: { type: "string", example: "Grupo Teste" },
      participantsCount: { type: "integer", example: 10 },
    },
  },
  {
    $id: "ApiError",
    type: "object",
    properties: {
      statusCode: { type: "integer", example: 400 },
      code: { type: "string", example: "VALIDATION_ERROR" },
      error: { type: "string", example: "Bad Request" },
      message: { type: "string", example: "Detalhe do erro" },
    },
  },
];

async function swaggerPlugin(app) {
  for (const schema of SHARED_SCHEMAS) {
    app.addSchema(schema);
  }

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "WhatsApp API",
        description:
          "Gateway WhatsApp com múltiplas sessões — padrão Z-API.\n\n" +
          "Todos os endpoints protegidos requerem `Authorization: Bearer <token>`.\n\n" +
          "**Query param `?id=`** é obrigatório em todos os endpoints de sessão.",
        version: "2.0.0",
      },
      servers: [{ url: "/", description: "Servidor local" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Token",
            description: "Token configurado em API_TOKEN no .env",
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: "Sessões", description: "Gerenciamento de sessões WhatsApp" },
        { name: "Mensagens", description: "Envio de mensagens (padrão Z-API)" },
        { name: "Contatos", description: "Verificação de contatos" },
        { name: "Chats", description: "Histórico de conversas" },
        { name: "Grupos", description: "Grupos do WhatsApp" },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  });
}

export default fp(swaggerPlugin, { name: "swagger" });
