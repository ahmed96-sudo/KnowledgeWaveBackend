import { execFileSync } from "node:child_process";

/** Applies the migrations to the Vitest database once per run. It never touches the dev database. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/knowledgewave_test";
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  } catch (e) {
    // Do not abort: DB-free tests can still run. DB-backed tests will fail with their own connection error.
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    console.warn(`\n[global-setup] could not migrate the test database (${url}). Is docker compose up?\n${err.stdout ?? ""}${err.stderr ?? ""}`);
  }
}
