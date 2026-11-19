// Appendix A of BACKEND_SPEC.md (verbatim from the frontend's src/lib/schemas/common.ts), except that
// LocalizedSchema lives in src/lib/localized.ts so there is one definition and one LOCALES list.
import { z } from "zod";
export { LocalizedSchema, type Localized } from "../lib/localized.js";

export const LocaleSchema = z.enum(["en", "ar"]);

/**
 * Where a lesson's video comes from.
 * - youtube: embedded via the IFrame API (optional start/end seconds to cut a long video into lessons)
 * - upload: an instructor-uploaded file; `assetId` points at the file the backend stores and streams.
 */
export const VideoSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("youtube"),
    id: z.string().length(11),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("upload"),
    assetId: z.string().min(1),
    mimeType: z.string().optional(),
  }),
]);
export type VideoSource = z.infer<typeof VideoSourceSchema>;

export const RoleSchema = z.enum(["student", "instructor", "admin"]);
export const LevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export type Level = z.infer<typeof LevelSchema>;
