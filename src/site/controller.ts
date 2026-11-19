import type { Request, Response } from "express";
import type { ContactInput } from "../schemas/user.js";
import * as service from "./service.js";

export async function contact(req: Request, res: Response) {
  await service.sendContactMessage(req.body as ContactInput);
  res.status(204).end();
}

export async function subscribe(req: Request, res: Response) {
  res.status(204).end(); // same answer whether or not the email was already subscribed
  await service.subscribe((req.body as { email: string }).email).catch((e) => console.error("newsletter subscribe failed", e));
}

const page = (heading: string, headingAr: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KnowledgeWave</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">
<h1>${heading}</h1><h1 dir="rtl">${headingAr}</h1></body></html>`;

export async function unsubscribe(req: Request, res: Response) {
  const ok = await service.unsubscribe((req.query as { token: string }).token);
  res
    .status(ok ? 200 : 404)
    .type("html")
    .send(ok ? page("You are unsubscribed.", "تم إلغاء اشتراكك.") : page("This unsubscribe link is not valid.", "رابط إلغاء الاشتراك غير صالح."));
}
