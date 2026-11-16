/**
 * Environment for `docker compose` calls made by the updater.
 *
 * The updater container loads the client's .env once, when it starts. Compose lets the process environment win over
 * the .env file, so a version written to .env during an update (APP_VERSION=...) would be ignored and the old image
 * pulled and restarted again. Every key that the .env file defines is therefore removed from the child environment,
 * so compose reads the file as it is now.
 */
export function composeEnv(base: NodeJS.ProcessEnv, envFileText: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const line of envFileText.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) delete env[m[1]!];
  }
  return env;
}
