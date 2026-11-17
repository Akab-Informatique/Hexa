export type EvoStatus = "todo" | "review" | "done";
export type PriorityTone = "red" | "orange" | "yellow" | "grey";

/** 9-10 red, 7-8 orange, 4-6 yellow, 1-3 grey. */
export const priorityTone = (p: number): PriorityTone => (p >= 9 ? "red" : p >= 7 ? "orange" : p >= 4 ? "yellow" : "grey");
export const TONE_COLOR: Record<PriorityTone, string> = { red: "#dc2626", orange: "#ea580c", yellow: "#ca8a04", grey: "#6b7280" };

/** Most urgent first, then oldest first. Does not mutate. */
export function sortEvolutions<T extends { priority: number; createdAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export const TABS = ["todo", "review", "done", "all"] as const;
export type EvoTab = (typeof TABS)[number];
export const inTab = (status: EvoStatus, tab: EvoTab) => tab === "all" || status === tab;
export const tabCounts = (rows: { status: EvoStatus }[]): Record<EvoTab, number> => ({
  todo: rows.filter((r) => r.status === "todo").length, review: rows.filter((r) => r.status === "review").length,
  done: rows.filter((r) => r.status === "done").length, all: rows.length,
});

/** Next status when the left control is clicked: todo -> review -> done -> back to todo. */
export const nextStatus = (s: EvoStatus): EvoStatus => (s === "todo" ? "review" : s === "review" ? "done" : "todo");

/** Prefixes each line of the selected range with "- " or "1. " (numbered). Returns the new text and selection. */
export function prefixLines(text: string, start: number, end: number, kind: "bullet" | "number") {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end);
  const to = nl === -1 ? text.length : nl;
  const lines = text.slice(from, to).split("\n").map((ln, i) => (kind === "bullet" ? "- " : `${i + 1}. `) + ln);
  const block = lines.join("\n");
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

/** Splits details into display lines: "- x" / "* x" become bullets, "1. x" numbered, others plain. Text only. */
export function parseDetails(details: string): { kind: "bullet" | "number" | "text" | "blank"; text: string; n?: string }[] {
  return details.split("\n").map((ln) => {
    const b = /^\s*[-*•]\s+(.*)$/.exec(ln);
    if (b) return { kind: "bullet" as const, text: b[1]! };
    const n = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(ln);
    if (n) return { kind: "number" as const, text: n[2]!, n: n[1]! };
    return ln.trim() ? { kind: "text" as const, text: ln } : { kind: "blank" as const, text: "" };
  });
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 3_000_000;
export const MAX_IMAGES = 6;
export const imageProblem = (f: { type: string; size: number }): "type" | "size" | null =>
  !IMAGE_TYPES.includes(f.type) ? "type" : f.size > MAX_IMAGE_BYTES ? "size" : null;
