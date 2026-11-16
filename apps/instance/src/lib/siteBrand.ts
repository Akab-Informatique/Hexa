import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// "Import my look from my website": fetch the firm's public site and suggest a logo and colors.
// The address is typed by a signed-in administrator but is still untrusted input for the server, so every request
// is guarded against reaching internal systems (SSRF): only http(s) on ports 80/443, the address the name resolves
// to is checked at connect time, each redirect is checked again, and size and time are capped.

export class SiteError extends Error { constructor(public code: string) { super(code); } }

/** Loopback, private, link-local, shared (CGNAT), documentation, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^(?:0:0:0:0:0:ffff:|::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (x.startsWith("::ffff:") || x.startsWith("0:0:0:0:0:ffff:") || x.startsWith("64:ff9b:")) return true; // other mapped / NAT64 forms: refuse
    const first = parseInt(x.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || x.startsWith("2001:db8");
  }
  return true;
}

export function parseSiteUrl(raw: string): URL {
  let s = raw.trim();
  if (!s) throw new SiteError("invalid_url");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw new SiteError("invalid_url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SiteError("invalid_url");
  if (u.username || u.password) throw new SiteError("invalid_url");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") throw new SiteError("blocked_address");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw new SiteError("blocked_address");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new SiteError("blocked_address");
  return u;
}

/** DNS lookup that refuses any answer pointing to an internal address, checked at the moment of connecting. */
const guardedLookup = ((hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(new SiteError("blocked_address"));
    if ((options as { all?: boolean }).all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}) as unknown as net.LookupFunction;

interface Reply { status: number; location?: string; type: string; body: Buffer }

function once(u: URL, o: { maxBytes: number; accept: string; timeoutMs: number; truncate: boolean }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", lookup: guardedLookup, timeout: o.timeoutMs, headers: { "user-agent": "Mozilla/5.0 (compatible; HexaBrandFetch/1.0)", accept: o.accept, "accept-encoding": "identity" } }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers["content-type"] ?? "").toLowerCase();
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location: res.headers.location, type, body: Buffer.alloc(0) }); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          if (!o.truncate) { req.destroy(new SiteError("too_large")); return; }
          chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
          req.destroy(); resolve({ status, type, body: Buffer.concat(chunks) }); return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status, type, body: Buffer.concat(chunks) }));
      res.on("error", (e) => reject(e));
    });
    req.on("timeout", () => req.destroy(new SiteError("timeout")));
    req.on("error", (e) => reject(e instanceof SiteError ? e : new SiteError("fetch_failed")));
    req.end();
  });
}

/** GET with up to 3 redirects, each one checked again. */
export async function safeGet(raw: string, o: { maxBytes: number; accept: string; timeoutMs?: number; truncate?: boolean }): Promise<{ url: string; type: string; body: Buffer }> {
  let u = parseSiteUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const r = await once(u, { maxBytes: o.maxBytes, accept: o.accept, timeoutMs: o.timeoutMs ?? 8000, truncate: o.truncate ?? false });
    if (r.status >= 300 && r.status < 400 && r.location) { u = parseSiteUrl(new URL(r.location, u).href); continue; }
    if (r.status !== 200) throw new SiteError("fetch_failed");
    return { url: u.href, type: r.type, body: r.body };
  }
  throw new SiteError("too_many_redirects");
}

// ------------------------------------------------------------------ Reading the page (pure, tested)
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

/** "#abc", "#aabbcc" or "rgb(1, 2, 3)" to "#aabbcc" (lower case); null for anything else. */
export function normalizeColor(v: string): string | null {
  const s = v.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return `#${m[1]!.split("").map((c) => c + c).join("")}`;
  m = s.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (m) return `#${m[1]}`;
  m = s.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
  if (m) { const n = [m[1], m[2], m[3]].map(Number); if (n.every((x) => x <= 255)) return `#${n.map((x) => x.toString(16).padStart(2, "0")).join("")}`; }
  return null;
}

export function hsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(((h * 60) + 360) % 360), s, l };
}

/** A usable brand color: not white, black or grey. */
export const isBrandy = (hex: string) => { const c = hsl(hex); return c.s >= 0.2 && c.l >= 0.1 && c.l <= 0.9; };

export interface ColorHit { hex: string; source: string }
export interface LogoHit { url: string; source: string }
export interface Found { title: string; colors: ColorHit[]; logos: LogoHit[]; stylesheets: string[]; manifest?: string }

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((x) => x !== undefined);
const abs = (href: string | undefined, base: string): string | null => {
  if (!href || /^(data|javascript|blob):/i.test(href.trim())) return null;
  try { const u = new URL(href.trim(), base); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
};

/** Colors written as CSS variables and the hexes used most often in a piece of CSS or HTML. */
export function colorsFromCss(css: string): ColorHit[] {
  const out: ColorHit[] = [];
  for (const m of css.matchAll(/--([\w-]*(?:primary|brand|accent|main|theme|secondary|color)[\w-]*)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/gi)) {
    if (/^wp--|^wp-|^global--/.test(m[1]!)) continue; // WordPress / block-editor default palette, not the firm's own colors
    const hex = normalizeColor(m[2]!);
    if (hex && isBrandy(hex)) out.push({ hex, source: `--${m[1]}` });
  }
  const count = new Map<string, number>();
  for (const m of css.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) { const hex = normalizeColor(m[0]); if (hex && isBrandy(hex)) count.set(hex, (count.get(hex) ?? 0) + 1); }
  for (const [hex, n] of [...count].sort((a, b) => b[1] - a[1]).slice(0, 6)) if (n >= 2) out.push({ hex, source: "used" });
  return out;
}

export function extractBrand(html: string, base: string): Found {
  const colors: ColorHit[] = [];
  const logos: LogoHit[] = [];
  const title = (html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];

  for (const m of metas) {
    const name = (attr(m, "name") ?? attr(m, "property") ?? "").toLowerCase();
    if (name === "theme-color" || name === "msapplication-tilecolor") { const hex = normalizeColor(attr(m, "content") ?? ""); if (hex) colors.push({ hex, source: name }); }
  }
  for (const i of imgs) {
    const hay = `${attr(i, "src") ?? ""} ${attr(i, "alt") ?? ""} ${attr(i, "class") ?? ""} ${attr(i, "id") ?? ""}`;
    if (/logo/i.test(hay)) { const u = abs(attr(i, "src") ?? attr(i, "data-src"), base); if (u) logos.push({ url: u, source: "logo" }); }
  }
  let manifest: string | undefined;
  const stylesheets: string[] = [];
  const icons: LogoHit[] = [];
  for (const l of links) {
    const rel = (attr(l, "rel") ?? "").toLowerCase();
    const href = abs(attr(l, "href"), base);
    if (!href) continue;
    if (rel.includes("apple-touch-icon")) icons.push({ url: href, source: "apple-touch-icon" });
    else if (rel.split(/\s+/).includes("icon") && !/\.ico(\?|$)/i.test(href)) icons.push({ url: href, source: "icon" });
    else if (rel.includes("manifest")) manifest = href;
    else if (rel.includes("stylesheet")) stylesheets.push(href);
  }
  // The big touch icon is a better logo than a 32px favicon.
  logos.push(...icons.sort((x, y) => Number(y.source === "apple-touch-icon") - Number(x.source === "apple-touch-icon")));
  for (const m of metas) {
    if ((attr(m, "property") ?? "").toLowerCase() === "og:image") { const u = abs(attr(m, "content"), base); if (u) logos.push({ url: u, source: "og:image" }); }
  }
  const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + "\n" + (html.match(/\sstyle\s*=\s*"[^"]*"/gi) ?? []).join("\n");
  colors.push(...colorsFromCss(styleText));

  const seen = new Set<string>();
  const uniqueLogos = logos.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))).slice(0, 6);
  return { title, colors: dedupeColors(colors), logos: uniqueLogos, stylesheets: stylesheets.slice(0, 3), manifest };
}

export function dedupeColors(list: ColorHit[]): ColorHit[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.hex) ? false : (seen.add(c.hex), true)));
}

/** Sniffs the real image type from the first bytes (a server's content-type header can lie). */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  const head = b.subarray(0, 600).toString("utf8").toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}
