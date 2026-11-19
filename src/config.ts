import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  // Public base URL of this API, used in links inside emails (newsletter unsubscribe)
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  // Number of reverse proxies in front of the app (e.g. 1). Empty = none. See README before deploying.
  TRUST_PROXY: z.string().default(""),
  SESSION_COOKIE_NAME: z.string().default("kw_sid"),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(7),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  MAIL_FROM: z.string().default("KnowledgeWave <no-reply@knowledgewave.dev>"),
  // Support inbox that receives contact-form messages
  CONTACT_TO: z.string().default("support@knowledgewave.dev"),
  STORAGE_DIR: z.string().default("./storage"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(524_288_000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
};
