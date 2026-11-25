import { randomUUID } from "node:crypto";
import request, { type Response } from "supertest";
import { hashPassword } from "../../src/auth/password.js";
import type { Role } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";

export const PASSWORD = "password123";
/** Every state-changing request needs this header (CSRF defence). */
export const H = { "X-Requested-With": "fetch" };

let defaultHash: Promise<string> | undefined;

export async function createUser(o: { role?: Role; email?: string; name?: string; password?: string; bannedAt?: Date; deletedAt?: Date } = {}) {
  const id = `u-${randomUUID()}`;
  const passwordHash = o.password ? await hashPassword(o.password) : await (defaultHash ??= hashPassword(PASSWORD));
  return prisma.user.create({
    data: {
      id,
      name: o.name ?? "Test User",
      email: o.email ?? `${id}@example.com`,
      passwordHash,
      role: o.role ?? "student",
      bannedAt: o.bannedAt ?? null,
      deletedAt: o.deletedAt ?? null,
      settings: { create: {} },
    },
  });
}

export const setCookies = (res: Response) => (res.headers["set-cookie"] ?? []) as unknown as string[];
export const cookie = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`));
/** The raw value of a Set-Cookie header, e.g. the session id. */
export const cookieValue = (res: Response, name: string) => cookie(res, name)?.split(";")[0]?.slice(name.length + 1);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A supertest agent (cookie jar) signed in as `email`. */
export async function agentFor(app: Parameters<typeof request.agent>[0], email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set(H).send({ email, password });
  if (res.status !== 200) throw new Error(`login as ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
