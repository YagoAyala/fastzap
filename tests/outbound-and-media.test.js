/**
 * Guards das duas regressões que chegaram em produção em 31/07/2026, ambas
 * silenciosas — nenhuma das duas produzia erro, só perda de funcionalidade:
 *
 * 1) MÍDIA. O gate `hasMedia` olhava a PRIMEIRA chave do conteúdo, e por isso
 *    barrava documento-com-legenda (embrulhado em `documentWithCaptionMessage`)
 *    e qualquer mídia precedida de `messageContextInfo`. O download nem era
 *    tentado; a Focca recebia `_baileysMedia: null` e respondia como se a
 *    mensagem fosse só texto.
 *
 * 2) FAIXA DE SAÍDA. Só `/send-text` e `/send-buttons` liam `lane`. As outras 8
 *    rotas caíam no default `proactive` e passavam a pagar o cap de 20/dia
 *    desenhado pra contato frio — inclusive a REAÇÃO, que é um recibo de
 *    leitura e só existe em resposta a algo. Em produção o cap estourou e
 *    passou a recusar os próprios recibos.
 *
 * Rode com: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MediaDownloader } from "../src/infrastructure/whatsapp/MediaDownloader.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("MediaDownloader.hasMedia", () => {
  test("reconhece documento COM legenda (documentWithCaptionMessage)", () => {
    const msg = {
      key: { id: "3EB0F97C" },
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: "application/pdf",
              fileName: "curriculo.pdf",
            },
          },
        },
      },
    };

    assert.equal(MediaDownloader.hasMedia(msg), true);
  });

  test("reconhece mídia quando messageContextInfo vem primeiro", () => {
    const msg = {
      key: { id: "x" },
      message: {
        messageContextInfo: { deviceListMetadataVersion: 2 },
        imageMessage: { mimetype: "image/jpeg" },
      },
    };

    assert.equal(MediaDownloader.hasMedia(msg), true);
  });

  test("reconhece mídia dentro de chat temporário (ephemeralMessage)", () => {
    const msg = {
      key: { id: "y" },
      message: {
        ephemeralMessage: {
          message: { audioMessage: { mimetype: "audio/ogg", ptt: true } },
        },
      },
    };

    assert.equal(MediaDownloader.hasMedia(msg), true);
  });

  test("texto puro continua NÃO sendo mídia", () => {
    assert.equal(
      MediaDownloader.hasMedia({ message: { conversation: "oi" } }),
      false,
    );
    assert.equal(MediaDownloader.hasMedia({}), false);
    assert.equal(MediaDownloader.hasMedia(null), false);
  });
});

describe("faixa de saída declarada em todas as rotas de envio", () => {
  // Guard estrutural: vale pras rotas que existem HOJE e pras que alguém criar
  // amanhã. Sem isto, a correção dura até o próximo `/send-*` copiado do errado.
  const source = readFileSync(
    join(root, "src/infrastructure/http/routes/messages.routes.js"),
    "utf8",
  );

  // `/send-presence` e `/read-message` não passam pela fila de saída (são sinais
  // de sessão, não mensagens). `/send-bulk` é proativo por definição.
  //
  // `/send-reaction` é exceção deliberada e no sentido CONTRÁRIO: ela não pode
  // aceitar faixa do chamador, senão daria pra rebaixar um recibo a proativo e
  // recusá-lo pelo cap. A faixa dela é fixa no use case — travado logo abaixo,
  // na suíte "reação é reativa por construção".
  const EXEMPT = new Set([
    "/send-presence",
    "/read-message",
    "/send-bulk",
    "/send-reaction",
  ]);

  const routes = [...source.matchAll(/"(\/send-[a-z-]+|\/read-message)"/g)]
    .map((m) => m[1])
    .filter((r) => !EXEMPT.has(r));

  test("existe rota de envio pra checar", () => {
    assert.ok(routes.length >= 8, `esperava >=8 rotas, achei ${routes.length}`);
  });

  for (const route of routes) {
    test(`${route} repassa lane`, () => {
      // Recorta o corpo do handler desta rota até a próxima declaração de rota.
      const start = source.indexOf(`"${route}"`);
      const rest = source.slice(start + route.length);
      const nextRoute = rest.search(/app\.post\(/);
      const body = nextRoute === -1 ? rest : rest.slice(0, nextRoute);

      assert.match(
        body,
        /lane/,
        `${route} não declara lane — cai em 'proactive' e passa a pagar o cap de contato frio`,
      );
    });
  }
});

describe("reação é reativa por construção", () => {
  const source = readFileSync(
    join(root, "src/application/chat/SendMessageUseCase.js"),
    "utf8",
  );

  test("sendReaction fixa lane reactive, sem depender do chamador", () => {
    const start = source.indexOf("async sendReaction");
    assert.ok(start > -1, "sendReaction sumiu");
    const body = source.slice(start, start + 900);

    assert.match(
      body,
      /lane:\s*["']reactive["']/,
      "sendReaction precisa fixar reactive: recibo 👀 não é contato frio e não pode ser recusado pelo cap",
    );
  });
});
