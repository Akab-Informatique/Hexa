import type { Context } from "hono";
import type { z } from "zod";
import { hasPermission } from "@nexo/shared/permissions";
import type { AuthCtx, Env } from "../auth/session.ts";

/** snake_case DB row -> camelCase JSON. */
export const camel = <T = Record<string, unknown>>(row: Record<string, unknown>): T =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v])) as T;
export const camelRows = <T = Record<string, unknown>>(r: { rows: Record<string, unknown>[] }): T[] => r.rows.map((x) => camel<T>(x));

/** Parses the JSON body; a ZodError becomes a 400 through the app-level error handler. */
export async function body<S extends z.ZodTypeAny>(c: Context<Env>, schema: S): Promise<z.infer<S>> {
  return schema.parse(await c.req.json().catch(() => ({})));
}

export const auth = (c: Context<Env>): AuthCtx => c.get("auth")!;
export const can = (c: Context<Env>, ...keys: string[]) => keys.some((k) => hasPermission(auth(c).rights, k));
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Builds "col = $n" fragments for a partial update from a camelCase patch and a column map. */
export function buildUpdate(patch: Record<string, unknown>, columns: Record<string, string>, startAt = 1) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = columns[k];
    if (v === undefined || !col) continue;
    values.push(v);
    sets.push(`${col} = $${startAt + values.length - 1}`);
  }
  return { sets, values };
}
