import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { sendMail } from "../lib/mail.js";
import { prisma } from "../lib/prisma.js";
import type { ContactInput } from "../schemas/user.js";

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim(); // no header injection through name/subject

/** Forwards a contact-form message to the support inbox; replying answers the sender. A mail failure surfaces as a 500. */
export async function sendContactMessage({ name, email, message }: ContactInput) {
  await sendMail({
    to: config.CONTACT_TO,
    replyTo: `${oneLine(name).replace(/[<>"]/g, "")} <${oneLine(email)}>`,
    subject: `[KnowledgeWave contact] ${oneLine(name)}`,
    text: `From: ${oneLine(name)} <${oneLine(email)}>\n\n${message}`,
  });
}

/** Subscribes (or re-subscribes) an email and sends the welcome mail with an unsubscribe link. Already subscribed: no-op. */
export async function subscribe(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
  if (existing && !existing.unsubscribedAt) return;
  const sub = existing
    ? await prisma.newsletterSubscriber.update({ where: { email }, data: { unsubscribedAt: null, subscribedAt: new Date() } })
    : await prisma.newsletterSubscriber.create({ data: { email, unsubscribeToken: randomBytes(24).toString("base64url") } });
  const link = `${config.API_PUBLIC_URL}/api/newsletter/unsubscribe?token=${sub.unsubscribeToken}`;
  await sendMail({
    to: email,
    subject: "Welcome to the KnowledgeWave newsletter | مرحباً بك في نشرة KnowledgeWave",
    text: `You are subscribed to the KnowledgeWave newsletter.\nUnsubscribe any time: ${link}\n\nتم اشتراكك في نشرة KnowledgeWave.\nيمكنك إلغاء الاشتراك في أي وقت: ${link}`,
    html: `<p>You are subscribed to the KnowledgeWave newsletter. <a href="${link}">Unsubscribe</a></p>
<div dir="rtl"><p>تم اشتراكك في نشرة KnowledgeWave. <a href="${link}">إلغاء الاشتراك</a></p></div>`,
  });
}

/** Returns false for an unknown token. Unsubscribing twice is fine. */
export async function unsubscribe(token: string) {
  const sub = await prisma.newsletterSubscriber.findUnique({ where: { unsubscribeToken: token } });
  if (!sub) return false;
  if (!sub.unsubscribedAt) await prisma.newsletterSubscriber.update({ where: { email: sub.email }, data: { unsubscribedAt: new Date() } });
  return true;
}
