import { prisma } from "../src/lib/prisma.js";
import { BaseSeedEnvSchema, seedBase } from "../src/seed-base.js";

const env = BaseSeedEnvSchema.safeParse(process.env);
if (!env.success) {
  console.error("seed:base needs ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in the environment:");
  for (const i of env.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}

try {
  const { created } = await seedBase(env.data);
  console.log(created ? `Created the admin account ${env.data.ADMIN_EMAIL}.` : `An account with ${env.data.ADMIN_EMAIL} already exists: nothing changed.`);
} finally {
  await prisma.$disconnect();
}
