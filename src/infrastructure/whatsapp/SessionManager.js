import fs from "fs";
import path from "path";
import pino from "pino";
import { BaileysClient } from "./BaileysClient.js";
import { SessionHealth } from "./SessionHealth.js";
import { env } from "../../config/env.js";
import {
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "../../domain/errors/index.js";

const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
}).child({
  module: "SessionManager",
});

const MAX_SETUP_ATTEMPTS = 3;

export class SessionManager {
  #clients = new Map();
  #retryCount = new Map();
  #pairingCodes = new Map();
  // O QR só era emitido no evento e devolvido na resposta do POST /sessions —
  // nunca era guardado. Como GET /sessions/:id/qr-code e GET /sessions/qr-screen
  // chamam getQrCode(), as duas rotas estouravam 500 ("getQrCode is not a
  // function"). E não bastaria guardar o primeiro: o WhatsApp expira o QR a cada
  // ~20s e o Baileys emite um novo, então o guardado tem que ser o mais recente,
  // senão a tela mostra um código morto.
  #qrCodes = new Map();
  #messageListeners = [];
  #statusListeners = [];
  #health = null;
  #healthTimer = null;
  #disconnectListeners = [];
  #authenticatedListeners = [];

  async restoreAll() {
    const sessionsDir = path.resolve(env.SESSIONS_DIR);

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
      logger.info("Diretório de sessões criado");
      return;
    }

    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const sessionDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("md_"))
      .map((e) => e.name.replace("md_", ""));

    if (sessionDirs.length === 0) {
      logger.info("Nenhuma sessão para restaurar");
      return;
    }

    const { restorable, orphaned } = this.#classifySessionDirs(
      sessionsDir,
      sessionDirs,
    );

    for (const id of orphaned) {
      // Quarentena, não destruição. O useMultiFileAuthState grava creds.json
      // sem tmp+rename: se o processo morrer no meio da escrita (OOM, restart),
      // o arquivo trunca — e apagar aqui destruiria a ÚNICA cópia das
      // credenciais, obrigando a re-parear na mão com o celular.
      const authDir = path.resolve(sessionsDir, `md_${id}`);
      const quarantine = `${authDir}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(authDir, quarantine);
        logger.warn(
          { sessionId: id, quarantine },
          "Sessão ilegível movida para quarentena no startup (não apagada)",
        );
      } catch (err) {
        logger.error(
          { sessionId: id, err: err?.message },
          "Falha ao pôr sessão ilegível em quarentena",
        );
      }
    }

    if (restorable.length === 0) {
      logger.info("Nenhuma sessão para restaurar");
      return;
    }

    logger.info({ count: restorable.length }, "Restaurando sessões");

    await Promise.allSettled(
      restorable.map((id) =>
        this.#startClient(id).catch((err) =>
          logger.error({ sessionId: id, err }, "Falha ao restaurar sessão"),
        ),
      ),
    );
  }

  #classifySessionDirs(sessionsDir, sessionDirs) {
    const restorable = [];
    const orphaned = [];

    for (const id of sessionDirs) {
      const credsPath = path.resolve(sessionsDir, `md_${id}`, "creds.json");

      if (!fs.existsSync(credsPath)) {
        logger.warn({ sessionId: id }, "Sessão sem creds.json");
        orphaned.push(id);
        continue;
      }

      try {
        JSON.parse(fs.readFileSync(credsPath, "utf8"));
        restorable.push(id);
      } catch (err) {
        logger.error(
          { sessionId: id, err: err.message },
          "creds.json corrompido",
        );
        orphaned.push(id);
      }
    }

    return { restorable, orphaned };
  }

  async create(sessionId, phoneNumber = null) {
    if (this.#clients.has(sessionId)) {
      const existingClient = this.#clients.get(sessionId);

      if (existingClient.isAuthenticated) {
        throw new SessionAlreadyExistsError(sessionId);
      }

      const cached = this.#pairingCodes.get(sessionId);
      if (cached && phoneNumber && Date.now() - cached.generatedAt < 60_000) {
        logger.info({ sessionId }, "Reutilizando pairing code existente");
        return { type: "pairing_code", value: cached.code };
      }

      logger.info(
        { sessionId },
        "Sessão não autenticada encontrada, destruindo antes de recriar",
      );
      await this.#destroyClient(sessionId);
    }

    this.#cleanAuthFromDisk(sessionId);

    return this.#createWithRetry(sessionId, phoneNumber, 1);
  }

  async delete(sessionId) {
    const client = this.#clients.get(sessionId);

    if (!client) {
      throw new SessionNotFoundError(sessionId);
    }

    this.#retryCount.delete(sessionId);
    this.#pairingCodes.delete(sessionId);
    this.#qrCodes.delete(sessionId);
    await client.disconnect();
    this.#clients.delete(sessionId);

    const authDir = path.resolve(env.SESSIONS_DIR, `md_${sessionId}`);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }

    logger.info({ sessionId }, "Sessão removida");
  }

  /** QR mais recente da sessão, ou null se já autenticou / não existe. */
  getQrCode(sessionId) {
    return this.#qrCodes.get(sessionId) ?? null;
  }

  getClient(sessionId) {
    return this.#clients.get(sessionId) ?? null;
  }

  has(sessionId) {
    return this.#clients.has(sessionId);
  }

  isConnected(sessionId) {
    const client = this.#clients.get(sessionId);
    return client?.isAuthenticated ?? false;
  }

  listIds() {
    return [...this.#clients.keys()];
  }

  onMessage(listener) {
    this.#messageListeners.push(listener);
  }

  onMessageStatus(listener) {
    this.#statusListeners.push(listener);
  }

  /**
   * Liga o vigia de silêncio. Roda a cada 5 min: o alerta é sobre AUSÊNCIA de
   * tráfego, então não existe evento que o dispare — precisa de relógio.
   */
  startHealthWatch(notifier) {
    if (this.#healthTimer) return;
    this.#health = new SessionHealth({ notifier });
    this.#healthTimer = setInterval(() => {
      try {
        this.#health.check();
      } catch (err) {
        logger.warn({ err: err?.message }, "Falha no vigia de saúde");
      }
    }, 5 * 60 * 1000);
    this.#healthTimer.unref?.();
    logger.info("Vigia de silêncio de entrada ativo (shadowban)");
  }

  healthSnapshot() {
    return this.#health?.snapshot() ?? null;
  }

  onDisconnect(listener) {
    this.#disconnectListeners.push(listener);
  }

  onAuthenticated(listener) {
    this.#authenticatedListeners.push(listener);
  }

  async #createWithRetry(sessionId, phoneNumber, attempt) {
    logger.info(
      { sessionId, attempt, maxAttempts: MAX_SETUP_ATTEMPTS },
      "Iniciando setup da sessão",
    );

    return new Promise((resolve, reject) => {
      const client = new BaileysClient(sessionId);

      const cleanup = () => {
        client.removeAllListeners();
      };

      client.once("pairing_code", (code) => {
        cleanup();
        this.#pairingCodes.set(sessionId, { code, generatedAt: Date.now() });
        this.#bindLiveEvents(sessionId, client);
        this.#clients.set(sessionId, client);
        logger.info({ sessionId, code }, "Pairing code gerado");
        resolve({ type: "pairing_code", value: code });
      });

      client.once("qr", (qrBase64) => {
        cleanup();
        this.#qrCodes.set(sessionId, qrBase64);
        this.#bindLiveEvents(sessionId, client);
        this.#clients.set(sessionId, client);
        logger.info({ sessionId }, "QR code gerado");
        resolve({ type: "qr", value: qrBase64 });
      });

      client.once("connected", () => {
        cleanup();
        this.#bindLiveEvents(sessionId, client);
        this.#clients.set(sessionId, client);
        logger.info(
          { sessionId },
          "Sessão conectada sem QR/pairing (creds válidas)",
        );
        resolve({ type: "authenticated" });
      });

      client.once("setup_failed", async (reason) => {
        cleanup();
        await client.close().catch(() => {});
        logger.warn({ sessionId, reason, attempt }, "Setup falhou");

        if (attempt < MAX_SETUP_ATTEMPTS) {
          const delay = attempt * 2000;
          logger.info({ sessionId, attempt, delay }, "Tentando novamente...");
          setTimeout(() => {
            this.#cleanAuthFromDisk(sessionId);
            this.#createWithRetry(sessionId, phoneNumber, attempt + 1)
              .then(resolve)
              .catch(reject);
          }, delay);
        } else {
          reject(
            new Error(
              `Falha ao iniciar sessão '${sessionId}' após ${MAX_SETUP_ATTEMPTS} tentativas: ${reason}`,
            ),
          );
        }
      });

      const timeout = setTimeout(async () => {
        cleanup();
        await client.close().catch(() => {});
        const mode = phoneNumber ? "pairing code" : "QR";
        reject(
          new Error(`Timeout aguardando ${mode} da sessão '${sessionId}'`),
        );
      }, 30_000);

      client.once("pairing_code", () => clearTimeout(timeout));
      client.once("qr", () => clearTimeout(timeout));
      client.once("connected", () => clearTimeout(timeout));
      client.once("setup_failed", () => clearTimeout(timeout));

      client.connect(phoneNumber).catch(async (err) => {
        cleanup();
        clearTimeout(timeout);
        await client.close().catch(() => {});
        reject(err);
      });
    });
  }

  #bindLiveEvents(sessionId, client) {
    // O `once` do setup pega só o primeiro QR. Este listener contínuo mantém o
    // mais recente, que é o que a tela precisa servir enquanto ninguém escaneia.
    client.on("qr", (qrBase64) => {
      this.#qrCodes.set(sessionId, qrBase64);
    });

    // Sem este ouvinte a sessão morre PARA SEMPRE em silêncio: depois de um
    // restartRequired, o primeiro connection.update costuma ser `close`, o
    // cliente emite setup_failed e retorna SEM emitir `disconnected` — então
    // #scheduleReconnect nunca era chamado. Sobrava um cliente zumbi no Map,
    // com o processo vivo e o /health verde, sem mandar nem receber nada.
    client.on("setup_failed", (reason) => {
      logger.warn(
        { sessionId, reason },
        "Setup falhou em sessão viva — reagendando reconexão",
      );
      this.#scheduleReconnect(sessionId);
    });

    client.on("connected", () => {
      this.#retryCount.set(sessionId, 0);
      logger.info({ sessionId }, "Sessão conectada");
    });

    client.on("authenticated", (phone) => {
      this.#pairingCodes.delete(sessionId);
      // Autenticou: o QR virou lixo e não pode continuar sendo servido.
      this.#qrCodes.delete(sessionId);
      logger.info({ sessionId, phoneNumber: phone }, "Sessão autenticada");
      for (const listener of this.#authenticatedListeners) {
        listener(sessionId, phone);
      }
    });

    client.on("disconnected", (reason, shouldReconnect) => {
      logger.warn(
        { sessionId, reason, shouldReconnect },
        "Sessão desconectada",
      );

      if (shouldReconnect) {
        this.#scheduleReconnect(sessionId);
      } else {
        this.#clients.delete(sessionId);
        this.#retryCount.delete(sessionId);

        for (const listener of this.#disconnectListeners) {
          listener(sessionId, reason);
        }
      }
    });

    client.on("message", (message, sid) => {
      this.#health?.recordInbound();
      for (const listener of this.#messageListeners) {
        listener(message, sid);
      }
    });

    client.on("message-status", (status, sid) => {
      for (const listener of this.#statusListeners) {
        listener(status, sid);
      }
    });
  }

  async #destroyClient(sessionId) {
    const client = this.#clients.get(sessionId);

    if (client) {
      client.removeAllListeners();
      await client.close().catch(() => {});
    }

    this.#clients.delete(sessionId);
    this.#pairingCodes.delete(sessionId);
    this.#qrCodes.delete(sessionId);
    this.#retryCount.delete(sessionId);
  }

  #cleanAuthFromDisk(sessionId) {
    const authDir = path.resolve(env.SESSIONS_DIR, `md_${sessionId}`);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info({ sessionId }, "Auth removida do disco");
    }
  }

  async #startClient(sessionId, phoneNumber = null) {
    const client = new BaileysClient(sessionId);
    this.#clients.set(sessionId, client);
    this.#bindLiveEvents(sessionId, client);
    await client.connect(phoneNumber);
  }

  #scheduleReconnect(sessionId) {
    const attempts = (this.#retryCount.get(sessionId) ?? 0) + 1;
    this.#retryCount.set(sessionId, attempts);

    if (attempts > env.MAX_RETRIES) {
      logger.error(
        { sessionId, attempts },
        "Máximo de tentativas atingido, sessão perdida",
      );
      this.#clients.delete(sessionId);
      this.#retryCount.delete(sessionId);

      for (const listener of this.#disconnectListeners) {
        listener(sessionId, "max_retries_exceeded");
      }

      return;
    }

    // Antes: delay linear e, na 6ª tentativa, DESISTIA PARA SEMPRE — ou seja,
    // qualquer indisponibilidade maior que ~75 segundos matava o gateway em
    // definitivo, sem cron nem healthcheck pra reativar. Agora o backoff é
    // exponencial com teto de 5min e MAX_RETRIES vira gatilho de ALERTA, não de
    // abandono: continua tentando pra sempre, porque desistir é sempre pior.
    const delay = Math.min(
      env.RECONNECT_INTERVAL_MS * 2 ** Math.max(0, attempts - 1),
      300_000
    );
    logger.info({ sessionId, attempts, delayMs: delay }, "Reconexão agendada");

    setTimeout(async () => {
      if (!this.#clients.has(sessionId)) return;

      try {
        const client = this.#clients.get(sessionId);
        client.removeAllListeners();
        await client.close().catch(() => {});
        this.#clients.delete(sessionId);
        await this.#startClient(sessionId);
      } catch (err) {
        logger.error({ sessionId, err }, "Falha ao reconectar sessão");
        this.#clients.delete(sessionId);
        this.#retryCount.delete(sessionId);

        for (const listener of this.#disconnectListeners) {
          listener(sessionId, "reconnect_failed");
        }
      }
    }, delay);
  }
}
