const errorResponse = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    code: { type: "string" },
    error: { type: "string" },
    message: { type: "string" },
  },
};

export const sessionQuerySchema = {
  tags: ["Grupos"],
  querystring: {
    type: "object",
    required: ["id"],
    properties: {
      id: {
        type: "string",
        minLength: 1,
        description: "ID da sessão",
        example: "minha-sessao",
      },
    },
  },
};

export const groupJidSchema = {
  tags: ["Grupos"],
  querystring: sessionQuerySchema.querystring,
  params: {
    type: "object",
    required: ["jid"],
    properties: {
      jid: {
        type: "string",
        minLength: 1,
        description: "JID do grupo",
        example: "123456789@g.us",
      },
    },
  },
};

export const listGroupsSchema = {
  tags: ["Grupos"],
  summary: "Listar grupos",
  description: "Retorna todos os grupos dos quais a sessão participa.",
  querystring: sessionQuerySchema.querystring,
  response: {
    200: {
      description: "Lista de grupos",
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: { type: "array", items: { $ref: "Group#" } },
      },
    },
    401: { description: "Não autorizado", ...errorResponse },
    404: { description: "Sessão não encontrada", ...errorResponse },
  },
};

export const groupMetaSchema = {
  tags: ["Grupos"],
  summary: "Metadados do grupo",
  description: "Retorna nome, participantes e demais metadados de um grupo.",
  querystring: sessionQuerySchema.querystring,
  params: groupJidSchema.params,
  response: {
    200: {
      description: "Metadados do grupo",
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: { $ref: "Group#" },
      },
    },
    401: { description: "Não autorizado", ...errorResponse },
    404: { description: "Sessão ou grupo não encontrado", ...errorResponse },
  },
};

export const sendGroupMessageSchema = {
  tags: ["Grupos"],
  summary: "Enviar mensagem para grupo",
  description:
    "Envia uma mensagem para um grupo pelo JID. Retorna no formato Z-API.",
  querystring: sessionQuerySchema.querystring,
  body: {
    type: "object",
    required: ["phone", "message"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: {
        type: "string",
        minLength: 1,
        description: "JID do grupo (ex: 123456789@g.us) ou número do grupo",
        example: "123456789@g.us",
      },
      message: {
        type: "object",
        description: "Payload de mensagem no formato do Baileys",
        example: { text: "Olá, grupo!" },
      },
    },
  },
  response: {
    200: {
      description: "Mensagem enviada",
      $ref: "MessageSent#",
    },
    401: { description: "Não autorizado", ...errorResponse },
    404: { description: "Sessão não encontrada", ...errorResponse },
  },
};

export const groupMessagesSchema = {
  tags: ["Grupos"],
  summary: "Mensagens do grupo",
  description:
    "Retorna o histórico de mensagens de um grupo com paginação por cursor.",
  querystring: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 1, example: "minha-sessao" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      cursor_id: {
        type: "string",
        description: "ID da mensagem cursor para paginação",
      },
      cursor_from_me: { type: "boolean" },
    },
  },
  params: groupJidSchema.params,
  response: {
    200: {
      description: "Mensagens do grupo",
      type: "object",
      properties: {
        success: { type: "boolean" },
        message: { type: "string" },
        data: { type: "array", items: { $ref: "Message#" } },
      },
    },
    401: { description: "Não autorizado", ...errorResponse },
    404: { description: "Sessão não encontrada", ...errorResponse },
  },
};
