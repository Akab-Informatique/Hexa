import { describe, expect, test } from "vitest";
import { imageProblem, inTab, nextStatus, parseDetails, prefixLines, priorityTone, sortEvolutions, tabCounts } from "../apps/web/src/modules/evolutions/logic.ts";
import { NAV_ALL } from "../apps/web/src/modules/registry.ts";
import { itemRights, MODIFY } from "../apps/web/src/modules/access.ts";

describe("evolutions logic", () => {
  test("priority buckets", () => {
    expect([1, 3, 4, 6, 7, 8, 9, 10].map(priorityTone)).toEqual(["grey", "grey", "yellow", "yellow", "orange", "orange", "red", "red"]);
  });
  test("sort: priority desc then oldest first, no mutation", () => {
    const rows = [{ id: "a", priority: 5, createdAt: "2026-02-01" }, { id: "b", priority: 9, createdAt: "2026-03-01" }, { id: "c", priority: 5, createdAt: "2026-01-01" }];
    expect(sortEvolutions(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows[0]!.id).toBe("a");
  });
  test("tabs, counts and status flow", () => {
    const rows = [{ status: "todo" as const }, { status: "review" as const }, { status: "done" as const }, { status: "todo" as const }];
    expect(tabCounts(rows)).toEqual({ todo: 2, review: 1, done: 1, all: 4 });
    expect(inTab("done", "all")).toBe(true);
    expect(inTab("done", "todo")).toBe(false);
    expect(nextStatus("todo")).toBe("review");
    expect(nextStatus("review")).toBe("done");
    expect(nextStatus("done")).toBe("todo");
  });
  test("list prefixes apply to every selected line", () => {
    expect(prefixLines("a\nb\nc", 0, 3, "bullet").text).toBe("- a\n- b\nc");
    expect(prefixLines("a\nb\nc", 2, 5, "number").text).toBe("a\n1. b\n2. c");
  });
  test("details parse into bullets, numbers, text", () => {
    expect(parseDetails("x\n- y\n2. z\n").map((r) => r.kind)).toEqual(["text", "bullet", "number", "blank"]);
  });
  test("image limits", () => {
    expect(imageProblem({ type: "image/svg+xml", size: 10 })).toBe("type");
    expect(imageProblem({ type: "image/png", size: 4_000_000 })).toBe("size");
    expect(imageProblem({ type: "image/png", size: 1000 })).toBeNull();
  });
  test("evolutions page is in the access grid: Accès view, Modifier edit", () => {
    const item = NAV_ALL.flatMap((s) => s.items).find((i) => i.path === "/evolutions")!;
    expect(itemRights(item).see).toContain("evolutions.view");
    expect(MODIFY["/evolutions"]).toEqual(["evolutions.edit"]);
  });
});
