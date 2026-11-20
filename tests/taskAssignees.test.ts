import { describe, expect, test } from "vitest";
import { MAX_ASSIGNEES, isAssigneeSql, normalizeAssignees } from "../apps/instance/src/lib/taskAssignees.ts";

describe("task assignees", () => {
  test("nothing said means no change", () => expect(normalizeAssignees(undefined, undefined)).toBeUndefined());
  test("legacy single id still works, null clears", () => {
    expect(normalizeAssignees(undefined, "a")).toEqual(["a"]);
    expect(normalizeAssignees(undefined, null)).toEqual([]);
  });
  test("the list wins, duplicates dropped, order kept (first = main)", () => expect(normalizeAssignees(["b", "a", "b"], "z")).toEqual(["b", "a"]));
  test("capped", () => expect(normalizeAssignees(Array.from({ length: 50 }, (_, i) => String(i)), undefined)).toHaveLength(MAX_ASSIGNEES));
  test("membership sql uses the given param and alias", () => expect(isAssigneeSql("$2", "s")).toContain("ta.task_id = s.id and ta.user_id = $2"));
});
