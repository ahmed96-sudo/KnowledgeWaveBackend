import { Router } from "express";
import { z } from "zod";
import { createLimiter } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import { ContactSchema } from "../schemas/user.js";
import * as c from "./controller.js";

const limit = createLimiter({ windowMs: 3_600_000, limit: 5 });
const newsletterLimit = createLimiter({ windowMs: 3_600_000, limit: 10 });

export const siteRoutes = Router();

siteRoutes.post("/contact", limit, validate({ body: ContactSchema }), c.contact);
siteRoutes.post("/newsletter", newsletterLimit, validate({ body: z.object({ email: z.email({ message: "invalidEmail" }) }) }), c.subscribe);
siteRoutes.get("/newsletter/unsubscribe", validate({ query: z.object({ token: z.string().min(1) }) }), c.unsubscribe);
