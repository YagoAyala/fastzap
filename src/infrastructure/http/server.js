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
      const healthy = ids.length === 0 || connected.length > 0;

      return reply.status(healthy ? 200 : 503).send({
        success: healthy,
        message: healthy ? "API operacional" : "Nenhuma sessão autenticada",
        data: {
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          activeSessions: ids.length,
          connectedSessions: connected.length,
          sessions: ids.map((id) => ({
            id,
            connected: sessionManager.isConnected(id),
          })),
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
