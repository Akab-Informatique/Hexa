import { describe, expect, it } from "vitest";
import { colorsFromCss, extractBrand, hsl, isBrandy, isPrivateAddress, normalizeColor, parseSiteUrl, safeGet, sniffImage } from "../apps/instance/src/lib/siteBrand.ts";

describe("site fetch guard (nothing internal can be reached)", () => {
  it("flags loopback, private, link-local, shared and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("lets public addresses through", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("accepts a plain host name, adding https", () => {
    expect(parseSiteUrl("abezeau.com").href).toBe("https://abezeau.com/");
    expect(parseSiteUrl(" http://example.com/page ").hostname).toBe("example.com");
  });
  it("refuses other protocols, internal names and addresses, odd ports and credentials", () => {
    for (const u of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "http://127.0.0.1", "http://localhost", "https://app.localhost", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5", "https://example.com:8080", "https://user:pw@example.com", "http://printer.local", "", "   "]) {
      expect(() => parseSiteUrl(u), u).toThrow();
    }
  });
  it("refuses to connect to an internal address", async () => {
    await expect(safeGet("http://127.0.0.1/", { maxBytes: 1000, accept: "*/*" })).rejects.toThrow("blocked_address");
    await expect(safeGet("http://169.254.169.254/", { maxBytes: 1000, accept: "*/*" })).rejects.toThrow("blocked_address");
  });
});

describe("colors", () => {
  it("normalizes hex and rgb", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#942E2D")).toBe("#942e2d");
    expect(normalizeColor("#942e2dcc")).toBe("#942e2d");
    expect(normalizeColor("rgb(148, 46, 45)")).toBe("#942e2d");
    expect(normalizeColor("rgba(0,0,0,.5)")).toBe("#000000");
    expect(normalizeColor("red")).toBeNull();
    expect(normalizeColor("rgb(300,0,0)")).toBeNull();
  });
  it("tells brand colors from white, black and grey", () => {
    expect(isBrandy("#942e2d")).toBe(true);
    expect(isBrandy("#c8a47e")).toBe(true);
    for (const g of ["#ffffff", "#000000", "#333333", "#cccccc", "#fafafa"]) expect(isBrandy(g), g).toBe(false);
    expect(hsl("#ff0000").h).toBe(0);
  });
  it("ignores the WordPress default palette", () => {
    expect(colorsFromCss(":root{--wp--preset--color--vivid-red:#cf2e2e;--ast-global-color-0:#942e2d}").map((h) => h.hex)).toEqual(["#942e2d"]);
  });
  it("reads CSS variables, then the colors used most", () => {
    const css = ":root{--brand-primary:#942e2d;--text:#222} a{color:#c8a47e} b{color:#c8a47e} i{color:#c8a47e} p{color:#fff} h1{color:#111}";
    const hits = colorsFromCss(css);
    expect(hits[0]).toEqual({ hex: "#942e2d", source: "--brand-primary" });
    expect(hits.some((h) => h.hex === "#c8a47e" && h.source === "used")).toBe(true);
    expect(hits.some((h) => h.hex === "#ffffff" || h.hex === "#111111")).toBe(false);
  });
});

describe("reading a page", () => {
  const html = `<html><head><title> A Bezeau  | Comptables </title>
    <meta name="theme-color" content="#942E2D">
    <link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" href="/img/icon-32.png">
    <link rel="apple-touch-icon" href="/img/touch.png"><link rel="manifest" href="/site.webmanifest">
    <link rel="stylesheet" href="/css/main.css"><meta property="og:image" content="https://cdn.example.com/share.jpg">
    <style>:root{--accent-color:#c8a47e}</style></head>
    <body><header><img class="site-logo" src="/img/logo-white.svg" alt="A Bezeau"><img src="/img/team.jpg" alt="team"><img src="data:image/png;base64,AAAA" alt="logo"></header></body></html>`;
  const f = extractBrand(html, "https://abezeau.com/fr/");

  it("finds the title, declared colors and style colors", () => {
    expect(f.title).toBe("A Bezeau | Comptables");
    expect(f.colors[0]).toEqual({ hex: "#942e2d", source: "theme-color" });
    expect(f.colors.some((c) => c.hex === "#c8a47e")).toBe(true);
  });
  it("finds logos, logo images first, resolved against the page, skipping .ico and inline data", () => {
    expect(f.logos.map((l) => l.url)).toEqual(["https://abezeau.com/img/logo-white.svg", "https://abezeau.com/img/touch.png", "https://abezeau.com/img/icon-32.png", "https://cdn.example.com/share.jpg"]);
    expect(f.logos[0]!.source).toBe("logo");
  });
  it("lists the stylesheets and the manifest to read next", () => {
    expect(f.stylesheets).toEqual(["https://abezeau.com/css/main.css"]);
    expect(f.manifest).toBe("https://abezeau.com/site.webmanifest");
  });
  it("copes with an empty page", () => {
    expect(extractBrand("", "https://x.com")).toMatchObject({ title: "", colors: [], logos: [] });
  });
});

describe("image sniffing", () => {
  it("recognizes real images by their first bytes, not by what a server says", () => {
    expect(sniffImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", "base64"))).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("<html><body>not an image</body></html>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
