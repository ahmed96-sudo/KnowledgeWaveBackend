import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "../src/lib/slug.js";

describe("slugify", () => {
  it("lower-cases, strips diacritics and collapses separators", () => {
    expect(slugify("Omar Haddad")).toBe("omar-haddad");
    expect(slugify("  Café  Déjà-vu!! ")).toBe("cafe-deja-vu");
  });

  it("is empty for Arabic-only text (callers use a fallback)", () => {
    expect(slugify("عمر حداد")).toBe("");
  });

  it("caps at 60 chars without a trailing dash", () => {
    const s = slugify("a".repeat(59) + " b");
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("adds -2, -3... until free and uses the fallback for empty slugs", async () => {
    const taken = new Set(["omar-haddad", "omar-haddad-2", "instructor"]);
    const isTaken = async (s: string) => taken.has(s);
    expect(await uniqueSlug("Omar Haddad", isTaken, "instructor")).toBe("omar-haddad-3");
    expect(await uniqueSlug("عمر", isTaken, "instructor")).toBe("instructor-2");
    expect(await uniqueSlug("New Person", isTaken, "instructor")).toBe("new-person");
  });
});
