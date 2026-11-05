import { config } from "./config.ts";
import { pool } from "./db.ts";
import { audit, seedSystemGroups } from "./auth/access.ts";
import { seedDemo } from "./seed/demo.ts";
import { hashPassword, MIN_PASSWORD } from "./auth/crypto.ts";

/** Seeds system groups, and on a brand-new install creates the first master administrator. */
export async function bootstrap(): Promise<void> {
  await seedSystemGroups();
  const { rows } = await pool.query("select count(*)::int as n from users");
  if (rows[0].n > 0) return;
  const { initialAdminEmail: email, initialAdminPassword: password } = config;
  if (!email || password.length < MIN_PASSWORD) {
    console.warn("[bootstrap] no users yet and INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (12+ chars) are not set: nobody can log in");
    return;
  }
  const r = await pool.query(
    `insert into users (kind, email, name, password_hash, must_change_password, is_master)
     values ('staff', $1, 'Administrateur', $2, true, true) returning id`,
    [email, await hashPassword(password)],
  );
  const group = await pool.query("select id from groups where slug = 'administrators'");
  await pool.query("insert into user_groups values ($1, $2)", [r.rows[0].id, group.rows[0].id]);
  if (config.seedProfile && config.seedProfile !== "none") await seedDemo(config.seedProfile, r.rows[0].id);
  await audit("bootstrap.admin_created", { target: email });
  console.log(`[bootstrap] created master administrator ${email} (must change password at first login)`);
}
