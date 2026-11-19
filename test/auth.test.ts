// Needs the test database (docker compose up). Mail is mocked: nothing is sent to Mailpit.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { sha256 } from "../src/lib/hash.js";
import { sendMail } from "../src/lib/mail.js";
import { prisma } from "../src/lib/prisma.js";
import { purgeExpired } from "../src/lib/purge.js";
import { resetDb } from "./helpers/db.js";
import { PASSWORD, H, cookie, cookieValue, createUser, setCookies, sleep } from "./helpers/users.js";

vi.mock("../src/lib/mail.js", () => ({ sendMail: vi.fn(async () => {}) }));

const mail = vi.mocked(sendMail);
const app = createApp();

const register = (body: Record<string, unknown> = {}) =>
  request(app).post("/api/auth/register").set(H).send({ name: "Amira Student", email: "new@example.com", password: PASSWORD, role: "student", ...body });
const login = (email: string, password = PASSWORD, agent: { post: typeof request.agent.prototype.post } = request(app)) =>
  agent.post("/api/auth/login").set(H).send({ email, password });
const agentFor = async (email: string) => {
  const agent = request.agent(app);
  const res = await login(email, PASSWORD, agent);
  expect(res.status).toBe(200);
  return { agent, res, sid: cookieValue(res, config.SESSION_COOKIE_NAME)! };
};
/** Asks for a reset link and returns the token that was "emailed". */
async function emailedToken(email: string) {
  mail.mockClear();
  expect((await request(app).post("/api/auth/forgot-password").set(H).send({ email })).status).toBe(204);
  await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
  return /token=([\w-]+)/.exec(mail.mock.calls[0]![0].text)![1]!;
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});
afterAll(() => prisma.$disconnect());

describe("register", () => {
  it("creates a student, signs them in and sets the cookies", async () => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").set(H).send({ name: " Amira Student ", email: "New@Example.com", password: PASSWORD, role: "student" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.stringMatching(/^u-/), name: "Amira Student", email: "new@example.com", role: "student" });

    const sid = cookie(res, "kw_sid")!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(sid).not.toMatch(/Secure/i); // only in production
    expect(cookie(res, "kw_session")).toMatch(/^kw_session=student/);
    expect(cookie(res, "kw_session")).not.toMatch(/HttpOnly/i); // readable hint for the Next proxy

    expect((await agent.get("/api/auth/me")).body).toEqual({ status: "ok", user: res.body, realUser: null });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: res.body.id }, include: { settings: true } });
    expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(row.settings).not.toBeNull();
  });

  it("an instructor also gets a public profile; slugs get -2, -3; Arabic-only names fall back", async () => {
    const a = await register({ name: "Omar Haddad", email: "a@example.com", role: "instructor" });
    const b = await register({ name: "Omar Haddad", email: "b@example.com", role: "instructor" });
    const c = await register({ name: "عمر حداد", email: "c@example.com", role: "instructor" });
    expect([a.body.instructorId, b.body.instructorId, c.body.instructorId]).toEqual(["omar-haddad", "omar-haddad-2", "instructor"]);
    const profile = await prisma.instructor.findUniqueOrThrow({ where: { id: "omar-haddad" } });
    expect(profile).toMatchObject({ headline: { en: "Instructor", ar: "مدرّب" }, rating: 0, students: 0, courses: 0 });
    expect(profile.name).toEqual({ en: "Omar Haddad", ar: "Omar Haddad" });
  });

  it("emailTaken (409), whatever the letter case", async () => {
    await createUser({ email: "taken@example.com" });
    const res = await register({ email: "TAKEN@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("emailTaken");
  });

  it("validates the body and refuses to register admins", async () => {
    const short = await register({ password: "short" });
    expect(short.status).toBe(422);
    expect(short.body.error).toMatchObject({ code: "validation", details: [{ path: "password", message: "passwordShort8" }] });
    expect((await register({ role: "admin" })).status).toBe(422);
  });
});

describe("login", () => {
  it("signs in with any email letter case", async () => {
    await createUser({ email: "amira@example.com", name: "Amira" });
    const res = await login("AMIRA@Example.com");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "amira@example.com", name: "Amira", role: "student" });
    expect(cookie(res, "kw_sid")).toBeDefined();
  });

  it("unknown email and wrong password are indistinguishable", async () => {
    await createUser({ email: "amira@example.com" });
    const wrongPassword = await login("amira@example.com", "wrong-password");
    const unknownEmail = await login("nobody@example.com");
    expect([wrongPassword.status, unknownEmail.status]).toEqual([401, 401]);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe("invalidCredentials");
  });

  it("a banned account gets `banned` only with the right password; deleted accounts do not exist", async () => {
    await createUser({ email: "banned@example.com", bannedAt: new Date() });
    await createUser({ email: "gone@example.com", deletedAt: new Date() });
    const banned = await login("banned@example.com");
    expect([banned.status, banned.body.error.code]).toEqual([403, "banned"]);
    expect((await login("banned@example.com", "wrong-password")).body.error.code).toBe("invalidCredentials");
    expect((await login("gone@example.com")).body.error.code).toBe("invalidCredentials");
  });

  it("every login starts a new session", async () => {
    await createUser({ email: "amira@example.com" });
    await login("amira@example.com");
    await login("amira@example.com");
    expect(await prisma.session.count()).toBe(2);
  });

  it("needs the X-Requested-With header (CSRF)", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "a@example.com", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });
});

describe("session lifecycle", () => {
  it("/auth/me without a session is 401 unauthenticated", async () => {
    const res = await request(app).get("/api/auth/me");
    expect([res.status, res.body.error.code]).toEqual([401, "unauthenticated"]);
  });

  it("the database stores only a hash of the session id", async () => {
    await createUser({ email: "amira@example.com" });
    const { sid } = await agentFor("amira@example.com");
    const rows = await prisma.session.findMany();
    expect(rows.map((r) => r.id)).toEqual([sha256(sid)]);
  });

  it("logout deletes the session: replaying the old cookie fails", async () => {
    await createUser({ email: "amira@example.com" });
    const { agent, sid } = await agentFor("amira@example.com");
    const out = await agent.post("/api/auth/logout").set(H);
    expect(out.status).toBe(204);
    expect(cookie(out, "kw_sid")).toMatch(/kw_sid=;/);
    expect(await prisma.session.count()).toBe(0);
    const replay = await request(app).get("/api/auth/me").set("Cookie", `kw_sid=${sid}`);
    expect([replay.status, replay.body.error.code]).toEqual([401, "unauthenticated"]);
  });

  it("logout without a session is still 204", async () => {
    expect((await request(app).post("/api/auth/logout").set(H)).status).toBe(204);
  });

  it("an expired session is rejected", async () => {
    await createUser({ email: "amira@example.com" });
    const { agent } = await agentFor("amira@example.com");
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("rolling expiry: renewed when it is more than an hour old, not on every request", async () => {
    await createUser({ email: "amira@example.com" });
    const { agent } = await agentFor("amira@example.com");
    expect(cookie(await agent.get("/api/auth/me"), "kw_sid")).toBeUndefined(); // fresh: no rewrite

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() + 86_400_000) } }); // one day left
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(cookie(res, "kw_sid")).toBeDefined();
    const [row] = await prisma.session.findMany();
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("a user banned after signing in gets 403 banned, their sessions are deleted and cookies cleared", async () => {
    const u = await createUser({ email: "amira@example.com" });
    const { agent } = await agentFor("amira@example.com");
    await prisma.user.update({ where: { id: u.id }, data: { bannedAt: new Date() } });
    const res = await agent.get("/api/auth/me");
    expect([res.status, res.body.error.code]).toEqual([403, "banned"]);
    expect(await prisma.session.count()).toBe(0);
    expect(cookie(res, "kw_sid")).toMatch(/kw_sid=;/);
  });

  it("a user deleted after signing in gets 401 gone", async () => {
    const u = await createUser({ email: "amira@example.com" });
    const { agent } = await agentFor("amira@example.com");
    await prisma.user.update({ where: { id: u.id }, data: { deletedAt: new Date() } });
    const res = await agent.get("/api/auth/me");
    expect([res.status, res.body.error.code]).toEqual([401, "gone"]);
    expect(await prisma.session.count()).toBe(0);
  });

  it("a ban also blocks other protected endpoints, not only /auth/me", async () => {
    const u = await createUser({ email: "amira@example.com" });
    const { agent } = await agentFor("amira@example.com");
    await prisma.user.update({ where: { id: u.id }, data: { bannedAt: new Date() } });
    const res = await agent.post("/api/auth/change-password").set(H).send({ current: PASSWORD, next: "another-password" });
    expect([res.status, res.body.error.code]).toEqual([403, "banned"]);
  });

  it("purgeExpired removes only expired rows", async () => {
    const u = await createUser();
    const past = new Date(Date.now() - 1000), future = new Date(Date.now() + 60_000);
    await prisma.session.createMany({ data: [{ id: "old", userId: u.id, expiresAt: past }, { id: "live", userId: u.id, expiresAt: future }] });
    await prisma.passwordResetToken.createMany({ data: [{ userId: u.id, tokenHash: "old", expiresAt: past }, { userId: u.id, tokenHash: "live", expiresAt: future }] });
    await prisma.idempotencyKey.createMany({
      data: [
        { userId: u.id, key: "old", method: "POST", path: "/x", requestHash: "h", status: "completed", expiresAt: past },
        { userId: u.id, key: "live", method: "POST", path: "/x", requestHash: "h", status: "completed", expiresAt: future },
      ],
    });
    await purgeExpired();
    expect((await prisma.session.findMany()).map((r) => r.id)).toEqual(["live"]);
    expect((await prisma.passwordResetToken.findMany()).map((r) => r.tokenHash)).toEqual(["live"]);
    expect((await prisma.idempotencyKey.findMany()).map((r) => r.key)).toEqual(["live"]);
  });
});

describe("acting as", () => {
  it("/auth/me returns the target as `user` and the admin as `realUser`; a banned target falls back to the admin", async () => {
    const admin = await createUser({ role: "admin", email: "admin@example.com", name: "Admin" });
    const student = await createUser({ email: "student@example.com", name: "Student" });
    const { agent } = await agentFor("admin@example.com");
    await prisma.session.updateMany({ data: { actingAsUserId: student.id } });

    const acting = await agent.get("/api/auth/me");
    expect(acting.body.user).toMatchObject({ id: student.id, role: "student" });
    expect(acting.body.realUser).toMatchObject({ id: admin.id, role: "admin" });
    expect(cookie(acting, "kw_session")).toMatch(/^kw_session=student/);
    expect(cookie(acting, "kw_actor")).toMatch(/^kw_actor=admin/);

    await prisma.user.update({ where: { id: student.id }, data: { bannedAt: new Date() } });
    const back = await agent.get("/api/auth/me");
    expect(back.status).toBe(200);
    expect(back.body.user.id).toBe(admin.id);
    expect(back.body.realUser).toBeNull();
    expect(cookie(back, "kw_actor")).toMatch(/kw_actor=;/);
    expect((await prisma.session.findFirstOrThrow()).actingAsUserId).toBeNull();
  });
});

describe("change password", () => {
  it("needs a session and a valid new password, and checks the current one", async () => {
    await createUser({ email: "amira@example.com" });
    expect((await request(app).post("/api/auth/change-password").set(H).send({ current: PASSWORD, next: "another-password" })).status).toBe(401);
    const { agent } = await agentFor("amira@example.com");
    const wrong = await agent.post("/api/auth/change-password").set(H).send({ current: "wrong-password", next: "another-password" });
    expect([wrong.status, wrong.body.error.code]).toEqual([401, "invalidCredentials"]);
    const short = await agent.post("/api/auth/change-password").set(H).send({ current: PASSWORD, next: "short" });
    expect([short.status, short.body.error.code]).toEqual([422, "validation"]);
  });

  it("changes the password, keeps this session and signs out the others", async () => {
    await createUser({ email: "amira@example.com" });
    const a = await agentFor("amira@example.com");
    const b = await agentFor("amira@example.com");
    const res = await a.agent.post("/api/auth/change-password").set(H).send({ current: PASSWORD, next: "another-password" });
    expect(res.status).toBe(204);
    expect((await a.agent.get("/api/auth/me")).status).toBe(200);
    expect((await b.agent.get("/api/auth/me")).status).toBe(401);
    expect((await login("amira@example.com", "another-password")).status).toBe(200);
    expect((await login("amira@example.com", PASSWORD)).body.error.code).toBe("invalidCredentials");
  });

  it("while acting as someone it changes the REAL (admin) password, never the target's", async () => {
    const admin = await createUser({ role: "admin", email: "admin@example.com" });
    const student = await createUser({ email: "student@example.com" });
    const { agent } = await agentFor("admin@example.com");
    await prisma.session.updateMany({ data: { actingAsUserId: student.id } });

    const res = await agent.post("/api/auth/change-password").set(H).send({ current: PASSWORD, next: "another-password" });
    expect(res.status).toBe(204);
    const [a, s] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: admin.id } }), prisma.user.findUniqueOrThrow({ where: { id: student.id } })]);
    expect(await verifyPassword(a.passwordHash, "another-password")).toBe(true);
    expect(await verifyPassword(s.passwordHash, PASSWORD)).toBe(true); // untouched
  });
});

describe("forgot password", () => {
  it("always answers 204 and sends nothing for unknown, banned or deleted accounts", async () => {
    await createUser({ email: "banned@example.com", bannedAt: new Date() });
    await createUser({ email: "gone@example.com", deletedAt: new Date() });
    for (const email of ["nobody@example.com", "banned@example.com", "gone@example.com"]) {
      expect((await request(app).post("/api/auth/forgot-password").set(H).send({ email })).status).toBe(204);
    }
    await sleep(150); // the work happens after the response
    expect(mail).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("emails a link whose token is stored hashed and expires in 10 minutes", async () => {
    const u = await createUser({ email: "amira@example.com" });
    const token = await emailedToken("amira@example.com");
    expect(mail.mock.calls[0]![0]).toMatchObject({ to: "amira@example.com" });
    expect(mail.mock.calls[0]![0].text).toContain(`${config.FRONTEND_URL}/reset-password?token=${token}`);
    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.tokenHash).not.toBe(token);
    expect(Math.abs(row.expiresAt.getTime() - (Date.now() + 10 * 60_000))).toBeLessThan(10_000);
  });

  it("a newer request replaces the older link", async () => {
    await createUser({ email: "amira@example.com" });
    const first = await emailedToken("amira@example.com");
    const second = await emailedToken("amira@example.com");
    expect(await prisma.passwordResetToken.count()).toBe(1);
    expect((await request(app).post("/api/auth/reset-password").set(H).send({ token: first, next: "another-password" })).body.error.code).toBe("invalid");
    expect((await request(app).post("/api/auth/reset-password").set(H).send({ token: second, next: "another-password" })).status).toBe(204);
  });

  it("validates the email", async () => {
    expect((await request(app).post("/api/auth/forgot-password").set(H).send({ email: "not-an-email" })).status).toBe(422);
  });
});

describe("reset password", () => {
  it("sets the new password, ends every session and burns the token", async () => {
    await createUser({ email: "amira@example.com" });
    const { agent } = await agentFor("amira@example.com");
    const token = await emailedToken("amira@example.com");

    const res = await request(app).post("/api/auth/reset-password").set(H).send({ token, next: "another-password" });
    expect(res.status).toBe(204);
    expect((await login("amira@example.com", "another-password")).status).toBe(200);
    expect((await login("amira@example.com", PASSWORD)).body.error.code).toBe("invalidCredentials");
    expect((await agent.get("/api/auth/me")).status).toBe(401); // the old session died
    expect((await prisma.passwordResetToken.findFirstOrThrow()).usedAt).not.toBeNull();

    const again = await request(app).post("/api/auth/reset-password").set(H).send({ token, next: "yet-another-one" });
    expect([again.status, again.body.error.code]).toEqual([422, "invalid"]);
  });

  it("rejects an expired or unknown token", async () => {
    await createUser({ email: "amira@example.com" });
    const token = await emailedToken("amira@example.com");
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post("/api/auth/reset-password").set(H).send({ token, next: "another-password" });
    expect([expired.status, expired.body.error.code]).toEqual([422, "invalid"]);
    const unknown = await request(app).post("/api/auth/reset-password").set(H).send({ token: "nope", next: "another-password" });
    expect(unknown.body.error.code).toBe("invalid");
  });

  it("a too-short password is a validation error and does not burn the token", async () => {
    await createUser({ email: "amira@example.com" });
    const token = await emailedToken("amira@example.com");
    const short = await request(app).post("/api/auth/reset-password").set(H).send({ token, next: "short" });
    expect([short.status, short.body.error.code]).toEqual([422, "validation"]);
    expect((await request(app).post("/api/auth/reset-password").set(H).send({ token, next: "another-password" })).status).toBe(204);
  });
});

it("login sets the session and role hint cookies and clears any stale kw_actor hint", async () => {
  await createUser({ email: "amira@example.com" });
  const res = await login("amira@example.com");
  expect(setCookies(res).map((c) => c.split("=")[0]).sort()).toEqual(["kw_actor", "kw_session", "kw_sid"]);
  expect(cookie(res, "kw_actor")).toMatch(/^kw_actor=;/); // an expired value, i.e. a deletion
  expect(cookie(res, "kw_session")).toMatch(/^kw_session=student/);
});
