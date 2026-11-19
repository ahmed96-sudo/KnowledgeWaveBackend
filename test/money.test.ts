import { describe, expect, it } from "vitest";
import { fromCents, toCents } from "../src/lib/money.js";

describe("money", () => {
  it("converts dollars to exact integer cents", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30); // float noise does not leak into the database
    expect(toCents(49.99 * 3)).toBe(14997);
  });

  it("round-trips", () => {
    for (const d of [0, 0.01, 19.99, 89.99, 1234.56]) expect(fromCents(toCents(d))).toBe(d);
  });
});
