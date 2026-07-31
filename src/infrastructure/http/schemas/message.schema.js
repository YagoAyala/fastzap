const sessionQuery = {
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

const messageSentResponse = {
  200: {
    description: "Mensagem enviada com sucesso",
    $ref: "MessageSent#",
  },
  400: {
    description: "Dados inválidos",
    type: "object",
    properties: {
      statusCode: { type: "integer" },
      code: { type: "string" },
      error: { type: "string" },
      message: { type: "string" },
    },
  },
  401: {
    description: "Não autorizado",
    type: "object",
    properties: { message: { type: "string" } },
  },
  404: {
    description: "Sessão não encontrada",
    type: "object",
    properties: { message: { type: "string" } },
  },
};

export const sendTextSchema = {
  tags: ["Mensagens"],
  summary: "Enviar texto",
  description: "Envia uma mensagem de texto simples para um número ou grupo.",
  ...sessionQuery,
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
      quotedId: {
        type: "string",
        description: "messageId da mensagem a ser citada na resposta.",
      },
      phone: {
        type: "string",
        minLength: 8,
        description: "Número do destinatário (DDI+DDD+Número) ou JID do grupo",
        example: "5511999999999",
      },
      message: {
        type: "string",
        minLength: 1,
        description: "Texto da mensagem",
        example: "Olá, tudo bem?",
      },
      delayMessage: {
        type: "number",
        minimum: 1,
        maximum: 15,
        description: "Delay em segundos antes de enviar (1-15)",
      },
    },
  },
  response: messageSentResponse,
};

export const sendImageSchema = {
  tags: ["Mensagens"],
  summary: "Enviar imagem",
  description: "Envia uma imagem via URL pública ou base64.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "image"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      image: {
        type: "string",
        minLength: 1,
        description:
          "URL pública ou Base64 da imagem (data:image/...;base64,...)",
        example: "https://exemplo.com/foto.jpg",
      },
      caption: {
        type: "string",
        description: "Legenda da imagem",
        example: "Foto do evento",
      },
      viewOnce: {
        type: "boolean",
        default: false,
        description: "Visualizar apenas uma vez",
      },
    },
  },
  response: messageSentResponse,
};

export const sendAudioSchema = {
  tags: ["Mensagens"],
  summary: "Enviar áudio",
  description:
    "Envia um arquivo de áudio. Use `ptt: true` para enviar como mensagem de voz.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "audio"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      audio: {
        type: "string",
        minLength: 1,
        description: "URL pública ou Base64 do áudio",
        example: "https://exemplo.com/audio.mp3",
      },
      ptt: {
        type: "boolean",
        default: true,
        description: "Se true, envia como mensagem de voz (PTT)",
      },
    },
  },
  response: messageSentResponse,
};

export const sendVideoSchema = {
  tags: ["Mensagens"],
  summary: "Enviar vídeo",
  description: "Envia um arquivo de vídeo via URL pública ou base64.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "video"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      video: {
        type: "string",
        minLength: 1,
        description: "URL pública ou Base64 do vídeo",
        example: "https://exemplo.com/video.mp4",
      },
      caption: { type: "string", example: "Confira o vídeo!" },
      viewOnce: { type: "boolean", default: false },
    },
  },
  response: messageSentResponse,
};

export const sendDocumentSchema = {
  tags: ["Mensagens"],
  summary: "Enviar documento",
  description:
    "Envia um arquivo (PDF, DOCX, XLSX, etc.) via URL pública ou base64.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "document", "fileName"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      document: {
        type: "string",
        minLength: 1,
        description: "URL pública ou Base64 do documento",
        example: "https://exemplo.com/relatorio.pdf",
      },
      fileName: {
        type: "string",
        minLength: 1,
        description: "Nome do arquivo com extensão",
        example: "relatorio.pdf",
      },
      caption: { type: "string", example: "Segue o relatório" },
    },
  },
  response: messageSentResponse,
};

export const sendLinkSchema = {
  tags: ["Mensagens"],
  summary: "Enviar link com preview",
  description: "Envia um texto com link e preview automático.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "message", "linkUrl"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      message: { type: "string", minLength: 1, example: "Acesse nosso site!" },
      linkUrl: {
        type: "string",
        format: "uri",
        description: "URL do link",
        example: "https://exemplo.com",
      },
      title: { type: "string", example: "Exemplo" },
      linkDescription: { type: "string", example: "Descrição do link" },
      image: {
        type: "string",
        description: "URL da imagem de thumbnail",
        example: "https://exemplo.com/thumb.jpg",
      },
    },
  },
  response: messageSentResponse,
};

export const sendLocationSchema = {
  tags: ["Mensagens"],
  summary: "Enviar localização",
  description: "Envia uma localização geográfica.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "lat", "lng"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      lat: { type: "number", description: "Latitude", example: -23.5505 },
      lng: { type: "number", description: "Longitude", example: -46.6333 },
      address: { type: "string", example: "Av. Paulista, 1000 — São Paulo" },
    },
  },
  response: messageSentResponse,
};

export const sendContactSchema = {
  tags: ["Mensagens"],
  summary: "Enviar contato",
  description: "Envia um cartão de contato (vCard).",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "contactName", "contactPhone"],
    properties: {
      lane: {
        type: "string",
        enum: ["reactive", "proactive"],
        description:
          "Faixa da fila de saída. `reactive` = resposta a quem acabou de escrever (prioridade, sem cap por destinatário). `proactive` = contato iniciado por nós (espaçado e limitado). Default: proactive.",
      },
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      contactName: { type: "string", minLength: 1, example: "João Silva" },
      contactPhone: { type: "string", minLength: 8, example: "5511988888888" },
    },
  },
  response: messageSentResponse,
};

export const sendReactionSchema = {
  tags: ["Mensagens"],
  summary: "Enviar reação",
  description:
    'Adiciona ou remove uma reação emoji em uma mensagem. Envie `reaction: ""` para remover.',
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "messageId", "reaction"],
    properties: {
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      messageId: { type: "string", minLength: 1, example: "3EB0ABC123DEF" },
      reaction: {
        type: "string",
        description: "Emoji da reação. String vazia para remover.",
        example: "❤️",
      },
    },
  },
  response: messageSentResponse,
};

export const sendBulkSchema = {
  tags: ["Mensagens"],
  summary: "Envio em massa",
  description:
    "Envia textos para múltiplos destinatários em sequência (máx. 100 itens).",
  ...sessionQuery,
  body: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: {
      type: "object",
      required: ["phone", "message"],
      properties: {
        phone: { type: "string", minLength: 8, example: "5511999999999" },
        message: { type: "string", minLength: 1, example: "Olá!" },
      },
    },
  },
  response: {
    200: {
      description: "Resultado do envio em massa",
      $ref: "BulkResult#",
    },
  },
};

export const sendButtonsSchema = {
  tags: ["Mensagens"],
  summary: "Enviar botões",
  description:
    "Envia uma mensagem com opções clicáveis. O Baileys removeu botão da API " +
    "tipada, mas o protocolo mantém InteractiveMessage/ButtonsMessage/ListMessage — " +
    "então tenta-se do mais rico ao mais simples e para na primeira estratégia que " +
    "o servidor aceitar. `poll` (enquete nativa) é o piso garantido e `text` " +
    "(menu numerado) a rede final. A resposta informa qual estratégia venceu.",
  ...sessionQuery,
  body: {
    type: "object",
    required: ["phone", "text", "buttons"],
    properties: {
      phone: { type: "string", minLength: 8, example: "5511999999999" },
      text: {
        type: "string",
        minLength: 1,
        description: "Corpo da mensagem / pergunta",
        example: "Confirma o gasto de R$ 87,50?",
      },
      footer: {
        type: "string",
        description: "Rodapé (ignorado na estratégia poll)",
        example: "Focca",
      },
      buttons: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        description:
          "Opções. `id` volta no webhook quando o usuário escolhe. Estratégias " +
          "de botão usam no máximo 3 opções; list/poll/text aceitam até 10.",
        items: {
          type: "object",
          required: ["id", "title"],
          properties: {
            id: { type: "string", minLength: 1, example: "CONFIRM_YES" },
            title: { type: "string", minLength: 1, example: "Sim, registrar" },
            description: {
              type: "string",
              description: "Subtítulo (só aparece na estratégia list)",
            },
          },
        },
      },
      strategies: {
        type: "array",
        description:
          "Limita/ordena a cascata. Útil pra testar uma estratégia isolada em " +
          "produção sem mexer no código. Padrão: todas, nessa ordem.",
        items: {
          type: "string",
          enum: ["interactive", "buttons", "list", "poll", "text"],
        },
        example: ["interactive", "poll"],
      },
    },
  },
  response: messageSentResponse,
};
