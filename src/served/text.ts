// The overlay's pure helpers, kept apart from the canvas so Node tests can import them: link options (?cap=), chat
// commands, nameplate text and colors, and the overlay's own code version.
export function sanitizeColor(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

export function parseCommand(text: unknown) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^!(jump|avatar|color)(?:\s+([^\s]+))?\s*$/i);
  if (!match) return null;
  // group 1 is not optional, and lower-cased it is one of the three words the pattern allows
  const type = match[1]!.toLowerCase() as "jump" | "avatar" | "color";
  if (type === "jump") return match[2] ? null : { type };
  if (type === "color") {
    const value = sanitizeColor(match[2]);
    return value ? { type, value } : null;
  }
  // the test needs at least one character, so group 2 matched
  return /^[a-z0-9_-]{1,64}$/i.test(match[2] || "") ? { type, value: match[2]!.toLowerCase() } : null;
}

// ?cap= in the link: whole numbers 1..100; anything else (missing, 0, negative, text) means no limit of its own (100).
export function parseCap(value: unknown, fallback = 100) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : fallback;
}
// The limit in force: the lower of the link's ?cap= and the channel setting (maxOnStream, set by mods). Either can only tighten.
export function effectiveCap(urlCap: unknown, serverMax: unknown) {
  const server = Number.isInteger(serverMax) ? Math.max(1, Math.min(100, serverMax)) : 100;
  return Math.min(parseCap(urlCap), server);
}

// Text cuts by whole characters (grapheme clusters), never through an emoji, a flag or a ZWJ family; Array.from
// (code points) is the fallback where Intl.Segmenter is missing. Zalgo is limited to 2 combining marks per character.
const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
const graphemesOf = (text: string) =>
  segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
export function stripExtraMarks(text: unknown) {
  return String(text ?? "").replace(/(\p{M}{2})\p{M}+/gu, "$1");
}
// At most `max` characters including the ellipsis, which is added only when something was cut.
export function truncateText(text: unknown, max: number, ellipsis = "") {
  const clean = stripExtraMarks(text),
    parts = graphemesOf(clean);
  if (parts.length <= max) return clean;
  return parts.slice(0, Math.max(0, max - Array.from(ellipsis).length)).join("") + ellipsis;
}
export const clipName = (text: unknown) => truncateText(text, 24, "…"); // nameplates

// Nameplate colors: Twitch chat colors can be near black (#0000ff, #8a2be2 ...). Below 4.5:1 against the dark stream
// backdrop the lightness goes up (hue and saturation stay) until the name reads, like Twitch's own dark mode.
const NAME_BACKDROP_LUM = 0.0053,
  NAME_MIN_CONTRAST = 4.5;
const channelLum = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
// every caller passes the three channels
const lumOf = ([r, g, b]: number[]) => 0.2126 * channelLum(r!) + 0.7152 * channelLum(g!) + 0.0722 * channelLum(b!);
const contrastOnDark = (rgb: number[]) => (lumOf(rgb) + 0.05) / (NAME_BACKDROP_LUM + 0.05);
function hslToRgb(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l),
    f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
export function readableColor(hex: string, minContrast = NAME_MIN_CONTRAST) {
  const color = sanitizeColor(hex);
  if (!color) return hex;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  if (contrastOnDark(rgb) >= minContrast) return color;
  // as: map keeps the three channels
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number],
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l0 = (max + min) / 2,
    d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  const h = d === 0 ? 0 : 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  let lo = l0,
    hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (contrastOnDark(hslToRgb(h, s, mid)) >= minContrast) hi = mid;
    else lo = mid;
  }
  let out = hslToRgb(h, s, hi);
  for (let l = hi; contrastOnDark(out) < minContrast && l < 1; l += 0.004) out = hslToRgb(h, s, l);
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// The overlay's own code version: vite.config.ts (servedBuild) writes ?v=<hash of the served modules> on the overlay's
// script URL in the built overlay.html, so the hash changes only when served code changes, not on every deploy.
export const overlayVersionFromUrl = (url: string) => {
  try {
    return (new URL(url).searchParams.get("v") || "").match(/^[0-9a-f]{6,64}$/i)?.[0] || "";
  } catch {
    return "";
  }
};
export const overlayVersionFromHtml = (html: unknown) =>
  String(html || "").match(/overlay\.js\?v=([0-9a-f]{6,64})/i)?.[1] || "";
