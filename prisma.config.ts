import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `migrate`/`generate` read DATABASE_URL; Vitest points it at the test DB (see vitest.config.ts)
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
