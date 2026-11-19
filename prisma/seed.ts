import { prisma } from "../src/lib/prisma.js";
import { seedAll } from "../src/seed.js";

try {
  console.log("Seeded:", await seedAll(prisma));
} finally {
  await prisma.$disconnect();
}
