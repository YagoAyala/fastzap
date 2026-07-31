import { env } from "./config/env.js";
import pino from "pino";

import { SessionManager } from "./infrastructure/whatsapp/SessionManager.js";
import { WebhookDispatcher } from "./infrastructure/webhook/WebhookDispatcher.js";
import { TelegramNotifier } from "./infrastructure/notifications/TelegramNotifier.js";

import { SessionRepository } from "./infrastructure/database/repositories/SessionRepository.js";
import { ChatRepository } from "./infrastructure/database/repositories/ChatRepository.js";
import { MessageRepository } from "./infrastructure/database/repositories/MessageRepository.js";
import { closeDatabase } from "./infrastructure/database/connection.js";

import { buildServer, startServer } from "./infrastructure/http/server.js";

const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  ...(env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  }),
}).child({ module: "main" });

async function bootstrap() {
  logger.info("Iniciando fastzap-whatsapp-api-v2...");

  const sessionRepository = new SessionRepository();
  const chatRepository = new ChatRepository();
  const messageRepository = new MessageRepository();

  const sessionManager = new SessionManager();

  const telegram = new TelegramNotifier();

  // Vigia de shadowban: o modo de falha em que a sessão segue autenticada, os
  // envios seguem "dando sucesso", e nada chega nem volta. É o único que não
  // aparece em nenhum log de erro — só na ausência de tráfego de entrada.
  sessionManager.startHealthWatch(telegram);

  sessionManager.onDisconnect(async (sessionId, reason) => {
    logger.warn({ sessionId, reason }, "Sessão perdida permanentemente");

    await sessionRepository
      .update(sessionId, { status: "disconnected" })
      .catch(() => {});

    await telegram.notifySessionLost(sessionId, reason);
  });

  sessionManager.onAuthenticated(async (sessionId, phoneNumber) => {
    await sessionRepository
      .update(sessionId, { status: "authenticated", phoneNumber, qrCode: null })
      .catch((err) =>
        logger.error({ err }, "Erro ao atualizar sessão no banco"),
      );
  });

  new WebhookDispatcher(sessionManager);

  await sessionManager.restoreAll();

  const allSessions = await sessionRepository.findAll();
  const staleAuthenticated = allSessions.filter(
    (s) => s.status === "authenticated" && !sessionManager.isConnected(s.id),
  );

  for (const session of staleAuthenticated) {
    logger.warn(
      { sessionId: session.id },
      "Sessão authenticated no banco sem client ativo — marcando como disconnected",
    );
    await sessionRepository
      .update(session.id, { status: "disconnected" })
      .catch((err) =>
        logger.error(
          { err, sessionId: session.id },
          "Erro ao sincronizar status da sessão",
        ),
      );
  }

  const app = buildServer({
    sessionManager,
    sessionRepository,
    chatRepository,
    messageRepository,
  });

  await startServer(app);

  logger.info(
    { host: env.HOST, port: env.PORT, env: env.NODE_ENV },
    "Servidor iniciado",
  );

  const shutdown = async (signal) => {
    logger.info({ signal }, "Sinal recebido, encerrando...");

    try {
      await app.close();
      await closeDatabase();
      logger.info("Encerramento concluído");
    } catch (err) {
      logger.error({ err }, "Erro durante encerramento");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Exceção não capturada");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Promise rejeitada não tratada");
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error("Falha fatal na inicialização:", err);
  process.exit(1);
});
