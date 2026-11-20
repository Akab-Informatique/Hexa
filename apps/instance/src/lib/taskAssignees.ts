import type { Pool, PoolClient } from "pg";

export const MAX_ASSIGNEES = 20;

/** SQL: "user $n is one of the assignees of task alias t". */
export const isAssigneeSql = (param: string, alias = "t") =>
  `exists (select 1 from task_assignees ta where ta.task_id = ${alias}.id and ta.user_id = ${param})`;

/** Reference rule: private tasks are hidden even from managers; "selected" only to chosen viewers. SQL: "user $n may see task alias t". */
export const taskVisibleSql = (param: string, alias = "t") =>
  `(${alias}.visibility = 'team' or ${alias}.created_by = ${param} or ${isAssigneeSql(param, alias)}
     or (${alias}.visibility = 'selected' and exists (select 1 from task_viewers v where v.task_id = ${alias}.id and v.user_id = ${param})))`;

/** SQL fragment: the assignees of task alias t as a json array [{id,name}], main assignee first. */
export const ASSIGNEES_JSON = `coalesce((select json_agg(json_build_object('id', u.id, 'name', u.name) order by (u.id = t.assignee_id) desc, ta.created_at, u.name)
                 from task_assignees ta join users u on u.id = ta.user_id where ta.task_id = t.id), '[]'::json) as assignees`;

/** Merge the new list and the legacy single id into one ordered, de-duplicated, capped list. undefined = caller said nothing. */
export function normalizeAssignees(ids: string[] | undefined, single: string | null | undefined): string[] | undefined {
  if (ids === undefined && single === undefined) return undefined;
  const list = ids ?? (single ? [single] : []);
  return [...new Set(list)].slice(0, MAX_ASSIGNEES);
}

/** Replace a task's assignees and keep tasks.assignee_id = first person. Caller validates ids (active staff). */
export async function setAssignees(db: Pool | PoolClient, taskId: string, ids: string[]) {
  await db.query("delete from task_assignees where task_id = $1 and not (user_id = any($2::uuid[]))", [taskId, ids]);
  if (ids.length) await db.query("insert into task_assignees (task_id, user_id) select $1, u from unnest($2::uuid[]) u on conflict do nothing", [taskId, ids]);
  await db.query("update tasks set assignee_id = $2 where id = $1", [taskId, ids[0] ?? null]);
}

/** Ids that are not active staff (empty array = all valid). */
export async function invalidAssignees(db: Pool | PoolClient, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const ok = (await db.query("select id from users where kind = 'staff' and active and id = any($1::uuid[])", [ids])).rows.map((r) => r.id as string);
  return ids.filter((i) => !ok.includes(i));
}
