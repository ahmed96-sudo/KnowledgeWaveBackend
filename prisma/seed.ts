import { prisma } from "../src/lib/prisma.js";
import { seedAll } from "../src/seed.js";
import { seedDemoStudent } from "../src/seed-demo.js";

try {
  console.log("Seeded:", await seedAll(prisma));
  console.log("Demo student:", await seedDemoStudent(prisma));
} finally {
  await prisma.$disconnect();
}
