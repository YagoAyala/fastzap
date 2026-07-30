import { proto } from "@whiskeysockets/baileys";
import { SessionNotFoundError, ValidationError } from "../../domain/errors/index.js";
import { PhoneFormatter } from "../../infrastructure/whatsapp/PhoneFormatter.js";

/**
 * Botões com degradação em cascata.
 *
 * O Baileys tirou botão da API tipada de envio, mas o protocolo mantém
 * InteractiveMessage (campo 45), ButtonsMessage (42) e ListMessage (36). Dá pra
 * montar o proto na mão — o que NÃO dá pra garantir é que o servidor da Meta
 * entregue e que o app do destinatário renderize, porque interativo é território
 * de conta Business API verificada.
 *
 * Então em vez de apostar tudo numa estratégia, tenta da mais rica pra mais
 * simples e para na primeira que o servidor aceitar. A enquete (nativa na API
 * tipada) é o piso: sempre entrega e é clicável. Texto numerado é a rede final.
 *
 * `strategies` permite fixar/limitar a cascata por chamada — é assim que se testa
 * uma estratégia isolada em produção sem mexer em código.
 */
const STRATEGY = {
  INTERACTIVE: "interactive",
  BUTTONS: "buttons",
  LIST: "list",
  POLL: "poll",
  TEXT: "text",
};

const DEFAULT_CASCADE = [
  STRATEGY.INTERACTIVE,
  STRATEGY.BUTTONS,
  STRATEGY.LIST,
  STRATEGY.POLL,
  STRATEGY.TEXT,
];

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

export class SendButtonsUseCase {
  constructor(sessionManager, logger = console) {
    this.sessionManager = sessionManager;
    this.logger = logger;
  }

  async execute({
    sessionId,
    phone,
    text,
    footer = "",
    buttons,
    strategies = DEFAULT_CASCADE,
  }) {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      throw new ValidationError("buttons: informe ao menos uma opção");
    }
    if (buttons.length > 10) {
      throw new ValidationError("buttons: máximo de 10 opções");
    }

    const client = this.sessionManager.getClient(sessionId);
    if (!client) throw new SessionNotFoundError(sessionId);

    const jid = PhoneFormatter.toJid(phone);
    const cascade = strategies.filter((s) => DEFAULT_CASCADE.includes(s));
    if (cascade.length === 0) {
      throw new ValidationError("strategies: nenhuma estratégia válida");
    }

    const attempted = [];

    for (const strategy of cascade) {
      try {
        const result = await this.#send(client, jid, strategy, {
          text,
          footer,
          buttons,
        });

        return {
          messageId: result.messageId,
          id: result.messageId,
          strategy,
          attempted,
        };
      } catch (error) {
        attempted.push({ strategy, error: error?.message ?? "erro" });
        this.logger.warn?.(
          { sessionId, strategy, error: error?.message },
          "Estratégia de botão falhou, tentando a próxima",
        );
      }
    }

    // Só chega aqui se até o texto numerado falhou — aí é a sessão que está ruim.
    throw new Error(
      `Nenhuma estratégia de botão funcionou: ${attempted
        .map((a) => `${a.strategy}(${a.error})`)
        .join(", ")}`,
    );
  }

  async #send(client, jid, strategy, payload) {
    switch (strategy) {
      case STRATEGY.INTERACTIVE:
        return this.#sendInteractive(client, jid, payload);
      case STRATEGY.BUTTONS:
        return this.#sendButtons(client, jid, payload);
      case STRATEGY.LIST:
        return this.#sendList(client, jid, payload);
      case STRATEGY.POLL:
        return this.#sendPoll(client, jid, payload);
      case STRATEGY.TEXT:
        return this.#sendText(client, jid, payload);
      default:
        throw new Error(`Estratégia desconhecida: ${strategy}`);
    }
  }

  /** InteractiveMessage + NativeFlowMessage — o botão "de verdade". */
  async #sendInteractive(client, jid, { text, footer, buttons }) {
    const interactive = proto.Message.InteractiveMessage.create({
      body: proto.Message.InteractiveMessage.Body.create({ text }),
      footer: proto.Message.InteractiveMessage.Footer.create({
        text: footer || "",
      }),
      nativeFlowMessage:
        proto.Message.InteractiveMessage.NativeFlowMessage.create({
          buttons: buttons.map((button) => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
              display_text: button.title,
              id: button.id,
            }),
          })),
        }),
    });

    // O wrapper viewOnceMessage é o que faz clientes recentes renderizarem o
    // nativeFlow; sem ele muita versão ignora a mensagem inteira.
    const generated = await client.sendRawMessage(jid, {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadataVersion: 2,
            deviceListMetadata: {},
          },
          interactiveMessage: interactive,
        },
      },
    });

    return { messageId: generated?.key?.id ?? null };
  }

  /** ButtonsMessage legado — algumas versões ainda desenham. */
  async #sendButtons(client, jid, { text, footer, buttons }) {
    const generated = await client.sendRawMessage(jid, {
      buttonsMessage: {
        contentText: text,
        footerText: footer || undefined,
        headerType: 1,
        buttons: buttons.slice(0, 3).map((button, index) => ({
          buttonId: button.id,
          buttonText: { displayText: button.title },
          type: 1,
          index,
        })),
      },
    });

    return { messageId: generated?.key?.id ?? null };
  }

  /** ListMessage — menu clicável; às vezes passa onde botão não passa. */
  async #sendList(client, jid, { text, footer, buttons }) {
    const generated = await client.sendRawMessage(jid, {
      listMessage: {
        title: "",
        description: text,
        footerText: footer || undefined,
        buttonText: "Escolher",
        listType: 1,
        sections: [
          {
            title: "Opções",
            rows: buttons.map((button) => ({
              rowId: button.id,
              title: button.title,
              description: button.description ?? "",
            })),
          },
        ],
      },
    });

    return { messageId: generated?.key?.id ?? null };
  }

  /**
   * Enquete — o piso garantido. Está na API tipada do Baileys, é nativa e
   * clicável. A resposta chega como pollUpdateMessage.
   */
  async #sendPoll(client, jid, { text, buttons }) {
    const result = await client.sendMessage(jid, {
      poll: {
        name: text,
        values: buttons.map((button) => button.title),
        selectableCount: 1,
      },
    });

    return { messageId: result?.key?.id ?? null };
  }

  /** Rede final: menu numerado em texto puro. Nunca falha. */
  async #sendText(client, jid, { text, footer, buttons }) {
    const options = buttons
      .map((button, index) => `${NUMBER_EMOJI[index] ?? `${index + 1}.`} ${button.title}`)
      .join("\n");
    const body = [text, "", options, "", footer || "_responda com o número_"]
      .filter((line) => line !== null)
      .join("\n");

    const result = await client.sendMessage(jid, { text: body });

    return { messageId: result?.key?.id ?? null };
  }
}

export { STRATEGY, DEFAULT_CASCADE };
