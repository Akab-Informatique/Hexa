import { describe, expect, test } from "vitest";
import { hierarchyProblem, relationRow, relationView, reverseKind } from "../packages/shared/src/clientRelations.ts";

describe("client relations", () => {
  test("reverse kinds", () => {
    expect(reverseKind("parent")).toBe("child");
    expect(reverseKind("child")).toBe("parent");
    for (const k of ["spouse", "married", "other"] as const) expect(reverseKind(k)).toBe(k);
  });
  test("stored once, seen from both sides", () => {
    const row = relationRow("me", "mom", "parent"); // mom is my parent
    expect(row).toEqual({ a: "mom", b: "me", kind: "parent" });
    expect(relationView(row, "me")).toEqual({ other: "mom", kind: "parent" });
    expect(relationView(row, "mom")).toEqual({ other: "me", kind: "child" });
    expect(relationRow("me", "kid", "child")).toEqual({ a: "me", b: "kid", kind: "parent" });
    const sp = relationRow("x", "y", "spouse");
    expect(relationView(sp, "y")).toEqual({ other: "x", kind: "spouse" });
    expect(relationView(sp, "z")).toBeNull();
  });
});

describe("hierarchy check", () => {
  test("self, cycle, depth", () => {
    expect(hierarchyProblem("a", "a", ["a"])).toBe("self");
    expect(hierarchyProblem("a", "b", ["b", "a"])).toBe("cycle");
    expect(hierarchyProblem("a", "b", ["b", "c"])).toBeNull();
    expect(hierarchyProblem("a", "b", ["b", "c", "d", "e", "f", "g", "h", "i"])).toBe("too_deep");
    expect(hierarchyProblem("a", "b", ["b"], 8)).toBe("too_deep");
  });
});
