import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "../../config/env.js";
import { errorHandlerPlugin } from "./plugins/errorHandler.js";
import fpAuth from "./plugins/auth.js";
import swaggerPlugin from "./plugins/swagger.js";
import { sessionRoutes } from "./routes/sessions.routes.js";
import { chatRoutes } from "./routes/chats.routes.js";
import { groupRoutes } from "./routes/groups.routes.js";
import { messageRoutes } from "./routes/messages.routes.js";
import { contactRoutes } from "./routes/contacts.routes.js";

export function buildServer({
  sessionManager,
  sessionRepository,
  chatRepository,
  messageRepository,
  alerts = null,
  outbox = null,
}) {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      ...(env.NODE_ENV !== "production" && {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }),
    },
    ajv: {
      customOptions: {
        strict: false,
        keywords: ["example"],
      },
    },
  });

  app.register(cors, { origin: true });
  app.register(swaggerPlugin);
  app.register(errorHandlerPlugin);
  app.register(fpAuth);

  app.get(
    "/health",
    { schema: { hide: true }, config: { public: true } },
    async (_req, reply) => {
      // `activeSessions` vinha de listIds(), que conta cliente ZUMBI: processo
      // vivo, socket morto, e o health devolvia 200 alegre enquanto o WhatsApp
      // estava fora do ar. Health que só sabe dizer "o processo subiu" é
      // falso-verde — o que importa é se a sessão está autenticada.
      const ids = sessionManager.listIds();
      const connected = ids.filter((id) => sessionManager.isConnected(id));

      // O buraco que sobrava: perda TERMINAL de sessão (loggedOut, forbidden,
      // max_retries) remove o cliente do mapa, `ids` volta vazio, e a regra
      // "sem sessão = saudável" devolvia 200 exatamente no estado em que o
      // gateway está mudo. O disco sabe quantas sessões deveriam existir —
      // pareado uma vez, esperado para sempre.
      const expected = sessionManager.expectedSessionIds?.() ?? [];
      const healthy =
        connected.length > 0 || (expected.length === 0 && ids.length === 0);

      const message = healthy
        ? "API operacional"
        : expected.length > 0 && ids.length === 0
          ? "Sessão pareada sumiu do gateway — reconexão não está acontecendo"
          : "Nenhuma sessão autenticada";

      return reply.status(healthy ? 200 : 503).send({
        success: healthy,
        message,
        data: {
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          activeSessions: ids.length,
          connectedSessions: connected.length,
          expectedSessions: expected.length,
          sessions: ids.map((id) => ({
            id,
            connected: sessionManager.isConnected(id),
          })),
          // Estado do produto, não do processo: silêncio de entrada é o único
          // sintoma de shadowban, e entrega pendente é o único sintoma de
          // "aceitei mas não entreguei".
          sessionHealth: sessionManager.healthSnapshot?.() ?? null,
          outbound:
            sessionManager.getClient?.(connected[0] ?? ids[0])?.outboundStats?.() ??
            null,
          alerts: alerts?.snapshot?.() ?? null,
          webhookOutbox: outbox?.snapshot?.() ?? null,
        },
      });
    },
  );

  app.register(sessionRoutes, {
    prefix: "/sessions",
    sessionManager,
    sessionRepository,
  });

  app.register(chatRoutes, {
    prefix: "/chats",
    sessionManager,
    chatRepository,
    messageRepository,
  });

  app.register(groupRoutes, {
    prefix: "/groups",
    sessionManager,
    chatRepository,
    messageRepository,
  });

  app.register(messageRoutes, {
    sessionManager,
  });

  app.register(contactRoutes, {
    prefix: "/contacts",
    sessionManager,
  });

  return app;
}

export async function startServer(app) {
  await app.listen({ host: env.HOST, port: env.PORT });
}
