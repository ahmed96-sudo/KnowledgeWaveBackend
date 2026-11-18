import { z } from "zod";

/** Supported content languages. To add one: append it here (no DB migration needed, columns are JSONB). */
export const LOCALES = ["en", "ar"] as const;
/** Locales every Localized value must have. A language added later stays optional so existing content keeps validating. */
export const REQUIRED_LOCALES = ["en", "ar"] as const;

export type Locale = (typeof LOCALES)[number];
export type Localized = Record<(typeof REQUIRED_LOCALES)[number], string> & Partial<Record<Locale, string>>;

/** `{ en: string, ar: string }` today, same rule as the frontend's LocalizedSchema (non-empty). Unknown keys are dropped. */
export const LocalizedSchema = z.object(
  Object.fromEntries(
    LOCALES.map((l) => [l, (REQUIRED_LOCALES as readonly string[]).includes(l) ? z.string().min(1) : z.string().min(1).optional()]),
  ),
) as unknown as z.ZodType<Localized>;
