import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests never touch the dev database: DATABASE_URL is redirected to the test DB
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/knowledgewave_test",
    },
    // DB-backed test files share one database, so run them one at a time
    fileParallelism: false,
  },
});
