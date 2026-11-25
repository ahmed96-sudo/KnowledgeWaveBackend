import { catalogCache } from "../../src/catalog/cache.js";
import { config } from "../../src/config.js";
import { prisma } from "../../src/lib/prisma.js";

/** Empties every table (except Prisma's migration history). Refuses to run on anything but a *_test database. */
export async function resetDb() {
  const dbName = new URL(config.DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`resetDb() refused: "${dbName}" is not a test database`);
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  catalogCache.clear();
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
