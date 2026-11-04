/** Read one KEY=value from .env text. */
export function getEnv(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim().replace(/^"(.*)"$/, "$1");
}

/** Replace (or append) KEY=value, keeping every other line untouched. */
export function setEnv(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return `${text.replace(/\n*$/, "\n")}${key}=${value}\n`;
}
