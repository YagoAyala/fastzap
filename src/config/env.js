import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(3333),

  API_TOKEN: z.string().min(1, "API_TOKEN é obrigatório"),
  QR_ACCESS_TOKEN: z.string().min(1, "QR_ACCESS_TOKEN é obrigatório"),

  DATABASE_URL: z.string().url("DATABASE_URL deve ser uma URL válida"),

  MAX_RETRIES: z.coerce.number().default(5),
  RECONNECT_INTERVAL_MS: z.coerce.number().default(5000),
  SESSIONS_DIR: z.string().default("./sessions"),

  // Prazo até declarar `undelivered` uma mensagem aceita que nunca recebeu
  // recibo de entrega. Precisa ser folgado: aparelho desligado produz o mesmo
  // silêncio de entrega morta, e o alarme só vale se quase não erra.
  DELIVERY_ACK_TIMEOUT_MS: z.coerce.number().default(15 * 60 * 1000),

  WEBHOOK_URL: z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .pipe(z.string().url().optional())
    .optional(),
  // Segredo compartilhado enviado como header x-gateway-secret. O webhook do
  // gateway não é assinado como o da Meta, então sem isto o destino não tem como
  // provar que a chamada veio daqui. Opcional pra não quebrar quem já usa.
  WEBHOOK_HEADER_SECRET: z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .optional(),
  WEBHOOK_MAX_RETRIES: z.coerce.number().default(3),
  WEBHOOK_RETRY_DELAY_MS: z.coerce.number().default(1000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(10_000),
  WEBHOOK_CONCURRENCY: z.coerce.number().min(1).max(64).default(4),
  WEBHOOK_RECEIPT_QUEUE_CAP: z.coerce.number().default(5000),
  WEBHOOK_OUTBOX_ENABLED: z
    .enum(["0", "1", "false", "true"])
    .default("1")
    .transform((v) => v === "1" || v === "true"),
  WEBHOOK_OUTBOX_TICK_MS: z.coerce.number().default(60_000),

  TELEGRAM_TOKEN: z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .optional(),
  TELEGRAM_CHAT_ID: z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.errors
    .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
    .join("\n");

  console.error("[CONFIG] Variáveis de ambiente inválidas:\n" + errors);
  process.exit(1);
}

export const env = parsed.data;
