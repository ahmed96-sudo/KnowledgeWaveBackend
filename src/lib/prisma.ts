import { PrismaPg } from "@prisma/adapter-pg";
import { catalogCache } from "../catalog/cache.js";
import { config } from "../config.js";
import { PrismaClient } from "../generated/prisma/client.js";

/** Writes to these models change what the public catalog shows, so they clear its cache. */
const CATALOG_MODELS = new Set(["Course", "Section", "Lesson", "Review", "Enrollment", "Category", "Instructor", "Roadmap", "RoadmapCourse", "Testimonial"]);
const READ_OPERATIONS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);

/**
 * The cache is cleared automatically after ANY write to a catalog model, so no write path (seed, learner actions,
 * instructor builder, admin) can forget to do it. A request that reads between a write and its commit can re-cache
 * old data; that is bounded by the cache TTL (60 s).
 */
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) }).$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (CATALOG_MODELS.has(model) && !READ_OPERATIONS.has(operation)) catalogCache.clear();
        return result;
      },
    },
  },
});

/** The client handed to `prisma.$transaction(async (tx) => ...)`. `prisma` itself also satisfies this type. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
