/** Rebuild with node --import tsx scripts/marketing/render-social-cards.mts. */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { marketing as en } from "../../packages/client/src/i18n/messages/en/marketing";
import { marketing as de } from "../../packages/client/src/i18n/messages/de/marketing";
import { GUIDES } from "../../packages/client/src/components/marketing/guide-content";
import { MARKETING_PAGES, socialCardPath } from "../../packages/client/src/lib/marketing-pages";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(process.argv[2] || resolve(root, "packages/client/public"));
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const mark = (await readFile(resolve(root, "packages/client/public/brand/mark-tile.svg"))).toString("base64");
const namespace: Record<string, string> = { "/": "landing", "/invoice-generator/": "invoiceGenerator", "/extension/": "extension", "/raycast/": "raycast", "/mobile/": "mobile", "/download/": "download", "/press/": "press", "/privacy/": "privacy", "/support/": "support" };

function wrap(value: string, max = 23): string[] {
  const lines: string[] = [];
  for (const word of value.split(/\s+/)) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > max) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines;
}

for (const locale of ["en", "de"] as const) {
  const catalog = (locale === "en" ? en : de) as unknown as Record<string, { meta?: { title: string }; hero?: { title: string } }>;
  for (const path of MARKETING_PAGES) {
    const slug = path.replace(/^\/+|\/+$/g, "");
    const guide = GUIDES[locale][slug];
    const title = guide?.title ?? catalog[namespace[path]]?.hero?.title ?? catalog[namespace[path]]?.meta?.title
      ?? (path === "/imprint/" ? (locale === "de" ? "Impressum" : "Imprint")
        : locale === "de" ? "Änderungen pro Version" : "What changed in each version");
    const lines = wrap(title);
    const fontSize = lines.length > 5 ? 43 : 48;
    const screenshot = guide?.shot ?? (path.includes("invoice") ? "web-invoice" : path === "/mobile/" ? "phone-track" : "web-track");
    const shot = await sharp(resolve(root, `packages/client/public/marketing/${screenshot}.png`))
      .resize(490, 430, { fit: "contain", background: "#ffffff" }).png().toBuffer();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
      <rect width="1200" height="630" fill="#1e1b4b"/>
      <image x="56" y="52" width="54" height="54" href="data:image/svg+xml;base64,${mark}"/>
      <text x="125" y="89" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">Track Your Time</text>
      <text fill="#ffffff" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700">${lines.map((line, i) => `<tspan x="56" y="${175 + i * (fontSize + 9)}">${escape(line)}</tspan>`).join("")}</text>
      <text x="56" y="572" fill="#c7d2fe" font-family="Arial, sans-serif" font-size="23">trackyourtime.dev${locale === "de" ? "/de/" : ""}</text>
      <rect x="653" y="147" width="494" height="434" rx="12" fill="#818cf8"/>
      <image x="655" y="149" width="490" height="430" href="data:image/png;base64,${shot.toString("base64")}"/>
    </svg>`;
    const destination = resolve(out, socialCardPath(locale, path).slice(1));
    await mkdir(dirname(destination), { recursive: true });
    await sharp(Buffer.from(svg)).png().toFile(destination);
  }
}
console.log(`Rendered ${MARKETING_PAGES.length * 2} localized social cards in ${out}/marketing/og`);
