import { createHash } from "node:crypto";

/** A stable uuid made from a text key: used as billing_items.source_id so the unique (source, source_id) index makes each charge or sale happen once. */
export function uuidFromKey(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
