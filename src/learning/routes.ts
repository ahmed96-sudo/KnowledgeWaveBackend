import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ProfileSchema, ReviewInputSchema, SettingsSchema } from "../schemas/learning.js";
import * as c from "./controller.js";

/** A real calendar day, YYYY-MM-DD (the learner's local day, sent by the client). */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "invalidDay" })
  .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d, { message: "invalidDay" });

const slug = z.string().min(1);
const seconds = z.number().finite().nonnegative();

export const learningRoutes = Router();
learningRoutes.use(requireAuth);

learningRoutes.get("/learning", c.learning);
learningRoutes.post("/enrollments", validate({ body: z.object({ slugs: z.array(slug).min(1).max(20) }) }), c.enroll);
learningRoutes.post("/lessons/:lessonId/complete", validate({ body: z.object({ courseSlug: slug }) }), c.completeLesson);
learningRoutes.put(
  "/progress",
  validate({ body: z.object({ courseSlug: slug, lessonId: slug, positionSec: seconds, watchedSec: seconds, day }) }),
  c.saveProgress,
);
learningRoutes.post(
  "/notes",
  validate({ body: z.object({ courseSlug: slug, lessonId: slug, atSec: seconds, text: z.string().trim().min(1).max(2000) }) }),
  c.addNote,
);
learningRoutes.delete("/notes/:id", c.deleteNote);
learningRoutes.put("/wishlist/:slug", c.addToWishlist);
learningRoutes.delete("/wishlist/:slug", c.removeFromWishlist);
learningRoutes.post("/notifications/read", validate({ body: z.object({ ids: z.array(z.string()).optional() }).optional() }), c.markRead);
learningRoutes.put("/reviews/:slug", validate({ body: ReviewInputSchema }), c.review);
learningRoutes.patch("/profile", validate({ body: ProfileSchema }), c.profile);
learningRoutes.patch("/settings", validate({ body: SettingsSchema.partial() }), c.settings);
