// Needs the test database (docker compose up). Mail is mocked: nothing is sent to Mailpit.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { sendMail } from "../src/lib/mail.js";
import { prisma } from "../src/lib/prisma.js";
import { resetDb } from "./helpers/db.js";
import { H, sleep } from "./helpers/users.js";

vi.mock("../src/lib/mail.js", () => ({ sendMail: vi.fn(async () => {}) }));

const mail = vi.mocked(sendMail);
const app = createApp();
const subscribe = (email: string) => request(app).post("/api/newsletter").set(H).send({ email });

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});
afterAll(() => prisma.$disconnect());

describe("contact", () => {
  it("forwards the message to the support inbox, replying goes to the sender", async () => {
    const res = await request(app).post("/api/contact").set(H).send({ name: "Amira", email: "amira@example.com", message: "I have a question about a course." });
    expect(res.status).toBe(204);
    expect(mail).toHaveBeenCalledTimes(1);
    const sent = mail.mock.calls[0]![0];
    expect(sent.to).toBe(config.CONTACT_TO);
    expect(sent.replyTo).toBe("Amira <amira@example.com>");
    expect(sent.text).toContain("I have a question about a course.");
  });

  it("cannot inject mail headers through the name", async () => {
    await request(app).post("/api/contact").set(H).send({ name: "Eve\r\nBcc: victim@example.com", email: "eve@example.com", message: "Hello there, friend." });
    const sent = mail.mock.calls[0]![0];
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.replyTo).not.toMatch(/[\r\n]/);
  });

  it("validates the body and needs the CSRF header", async () => {
    const bad = await request(app).post("/api/contact").set(H).send({ name: "A", email: "nope", message: "short" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "message", "name"]);
    expect((await request(app).post("/api/contact").send({ name: "Amira", email: "a@example.com", message: "Long enough message." })).status).toBe(403);
    expect(mail).not.toHaveBeenCalled();
  });
});

describe("newsletter", () => {
  it("subscribes (email stored lower-case) and sends a welcome mail with an unsubscribe link", async () => {
    expect((await subscribe("Reader@Example.com")).status).toBe(204);
    await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
    const sub = await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email: "reader@example.com" } });
    expect(sub.unsubscribedAt).toBeNull();
    const sent = mail.mock.calls[0]![0];
    expect(sent.to).toBe("reader@example.com");
    expect(sent.text).toContain(`${config.API_PUBLIC_URL}/api/newsletter/unsubscribe?token=${sub.unsubscribeToken}`);
  });

  it("subscribing twice is a quiet no-op (same 204, one mail, one row)", async () => {
    await subscribe("reader@example.com");
    await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
    expect((await subscribe("reader@example.com")).status).toBe(204);
    await sleep(150);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(await prisma.newsletterSubscriber.count()).toBe(1);
  });

  it("the unsubscribe link works (twice), a bad token is 404, a missing token is a validation error", async () => {
    await subscribe("reader@example.com");
    await vi.waitFor(() => expect(prisma.newsletterSubscriber.count()).resolves.toBe(1));
    const { unsubscribeToken } = await prisma.newsletterSubscriber.findFirstOrThrow();

    for (let i = 0; i < 2; i++) {
      const res = await request(app).get(`/api/newsletter/unsubscribe?token=${unsubscribeToken}`); // GET: no CSRF header needed
      expect(res.status).toBe(200);
      expect(res.type).toBe("text/html");
      expect(res.text).toContain("unsubscribed");
    }
    expect((await prisma.newsletterSubscriber.findFirstOrThrow()).unsubscribedAt).not.toBeNull();
    expect((await request(app).get("/api/newsletter/unsubscribe?token=nope")).status).toBe(404);
    expect((await request(app).get("/api/newsletter/unsubscribe")).status).toBe(422);
  });

  it("re-subscribing after unsubscribing works and welcomes again with the same link", async () => {
    await subscribe("reader@example.com");
    await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
    const { unsubscribeToken } = await prisma.newsletterSubscriber.findFirstOrThrow();
    await request(app).get(`/api/newsletter/unsubscribe?token=${unsubscribeToken}`);

    await subscribe("reader@example.com");
    await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(2));
    const sub = await prisma.newsletterSubscriber.findFirstOrThrow();
    expect(sub.unsubscribedAt).toBeNull();
    expect(sub.unsubscribeToken).toBe(unsubscribeToken);
  });

  it("validates the email", async () => {
    expect((await subscribe("not-an-email")).status).toBe(422);
  });
});
