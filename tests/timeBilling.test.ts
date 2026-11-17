import { describe, expect, it } from "vitest";
import { billedHours } from "../apps/instance/src/lib/timeBilling.ts";

describe("billedHours", () => {
  it("uses billable minutes when set, else all minutes", () => {
    expect(billedHours(90, null)).toBe(1.5);
    expect(billedHours(90, 60)).toBe(1);
    expect(billedHours(100, undefined)).toBe(1.67);
    expect(billedHours(90, 0)).toBe(0);
  });
});
