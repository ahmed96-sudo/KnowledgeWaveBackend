import { describe, expect, it } from "vitest";
import { LocalizedSchema } from "../src/lib/localized.js";

describe("LocalizedSchema", () => {
  it("accepts en + ar", () => {
    expect(LocalizedSchema.parse({ en: "Hi", ar: "مرحبا" })).toEqual({ en: "Hi", ar: "مرحبا" });
  });

  it("rejects a missing or empty required locale", () => {
    expect(LocalizedSchema.safeParse({ en: "Hi" }).success).toBe(false);
    expect(LocalizedSchema.safeParse({ en: "Hi", ar: "" }).success).toBe(false);
  });

  it("drops keys that are not in LOCALES", () => {
    expect(LocalizedSchema.parse({ en: "Hi", ar: "مرحبا", fr: "Salut" })).toEqual({ en: "Hi", ar: "مرحبا" });
  });
});
