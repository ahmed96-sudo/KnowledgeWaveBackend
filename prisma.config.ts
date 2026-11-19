import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  // Prisma 7 no longer seeds after `migrate reset`: run `npm run seed` (= `prisma db seed`) yourself
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // `migrate`/`generate` read DATABASE_URL; Vitest points it at the test DB (see vitest.config.ts)
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
