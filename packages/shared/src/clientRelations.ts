/** Links between clients. A stored row (a, b, "parent") reads "a is the parent of b"; the other kinds are symmetric. */
export const RELATION_KINDS = ["spouse", "married", "parent", "child", "other"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** What the other client is to me, when I am the other's X. */
export const reverseKind = (k: RelationKind): RelationKind => (k === "parent" ? "child" : k === "child" ? "parent" : k);

/** The row to store for "other is my <kind>" (self = the client whose record is open). Child is stored as a flipped parent. */
export function relationRow(self: string, other: string, kind: RelationKind): { a: string; b: string; kind: RelationKind } {
  if (kind === "parent") return { a: other, b: self, kind: "parent" };
  if (kind === "child") return { a: self, b: other, kind: "parent" };
  return { a: self, b: other, kind };
}

/** From `self`'s point of view: who the other client is and what they are to self. Null when the row does not involve self. */
export function relationView(row: { a: string; b: string; kind: RelationKind }, self: string): { other: string; kind: RelationKind } | null {
  if (row.a === self) return { other: row.b, kind: row.kind === "parent" ? "child" : row.kind };
  if (row.b === self) return { other: row.a, kind: row.kind === "parent" ? "parent" : row.kind };
  return null;
}

export const MAX_HIERARCHY_DEPTH = 8;

/**
 * Can `parentId` become the parent of `clientId`? `chain` = parentId followed by its ancestors, nearest first.
 * Returns the problem, or null when fine.
 */
export function hierarchyProblem(clientId: string, parentId: string, chain: string[], subtreeHeight = 0): "self" | "cycle" | "too_deep" | null {
  if (clientId === parentId) return "self";
  if (chain.includes(clientId)) return "cycle";
  if (chain.length + 1 + subtreeHeight > MAX_HIERARCHY_DEPTH) return "too_deep";
  return null;
}
