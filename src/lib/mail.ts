import nodemailer from "nodemailer";
import { config } from "../config.js";

// Dev: Mailpit (docker compose) catches everything; open http://localhost:8025 to read it.
const transport = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: false, ignoreTLS: true });

export function sendMail(msg: { to: string; subject: string; text: string; html?: string; replyTo?: string }) {
  return transport.sendMail({ from: config.MAIL_FROM, ...msg });
}
