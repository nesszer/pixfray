// Pure helpers of the OBS overlay (src/served/text.ts): limits, text cutting, name colors, version parsing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCap,
  effectiveCap,
  stripExtraMarks,
  truncateText,
  clipName,
  readableColor,
  overlayVersionFromUrl,
  overlayVersionFromHtml,
} from "../src/served/text.ts";

test("overlay: parseCap floors, clamps to 100 and falls back for anything below 1 or not a number", () => {
  for (const [value, cap] of Object.entries({ 8: 8, 8.9: 8, 1: 1, 100: 100, 250: 100 }))
    assert.equal(parseCap(value), cap);
  for (const bad of [null, undefined, "", "abc", "0", "0.5", "-3", "NaN", "Infinity", "1e999"])
    assert.equal(parseCap(bad), 100, "default for " + String(bad));
  assert.equal(parseCap("abc", 40), 40, "a custom default is used");
});

test("overlay: effectiveCap is the lower of the link cap and the channel limit", () => {
  for (const [link, channel, cap, why] of [
    [8, 15, 8, "link cap lower than the channel limit wins"],
    [40, 15, 15, "channel limit lower than the link cap wins"],
    [100, 50, 50, "no link cap: the channel limit applies"],
    [8, undefined, 8, "no channel limit yet"],
    [undefined, undefined, 100, "no limits at all"],
    [8, 0, 1, "never below 1"],
    [8, 500, 8, "channel limit is clamped to 100"],
  ])
    assert.equal(effectiveCap(link, channel), cap, String(why));
});

test("overlay: truncateText never cuts through an emoji, a flag or a ZWJ family", () => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
  const flag = "\u{1F1E9}\u{1F1EA}";
  assert.equal(truncateText("hello", 10), "hello");
  assert.equal(truncateText("hello world", 5), "hello");
  assert.equal(truncateText("hello world", 5, "…"), "hell…", "the ellipsis counts toward the limit");
  assert.equal(truncateText("abc" + family + "def", 4), "abc" + family, "a ZWJ family stays whole");
  assert.equal(truncateText("ab" + family + "def", 2), "ab");
  assert.equal(truncateText(flag.repeat(3), 2), flag.repeat(2), "flags stay whole");
  assert.equal(truncateText("x".repeat(30), 24, "…"), "x".repeat(23) + "…");
  assert.equal(truncateText("", 5), "");
  assert.equal(truncateText(undefined, 5), "");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let n = 1; n < 12; n++)
    assert.ok(!lone.test(truncateText("\u{1F600}".repeat(8) + family, n)), "no lone surrogate at " + n);
});

test("overlay: stripExtraMarks keeps at most 2 combining marks per character", () => {
  const zalgo = "a" + "̀́̂̃̄̅" + "b";
  assert.equal(stripExtraMarks(zalgo), "à́b");
  assert.equal(stripExtraMarks("é"), "é", "one mark is untouched");
  assert.equal(stripExtraMarks("plain"), "plain");
  assert.equal(truncateText(zalgo, 2), "à́b", "marks are limited before counting");
});

test("overlay: clipName cuts nameplates at 24 characters with a whole-character ellipsis", () => {
  assert.equal(clipName("short"), "short");
  assert.equal(clipName("x".repeat(24)), "x".repeat(24));
  assert.equal(clipName("x".repeat(25)), "x".repeat(23) + "…");
  const heart = "\u{1F469}‍❤️‍\u{1F468}";
  const cut = clipName("x".repeat(22) + heart + heart + heart); // 25 characters
  assert.equal(cut, "x".repeat(22) + heart + "…", "cut after a whole joined emoji");
  assert.equal(
    clipName("x".repeat(23) + heart + heart),
    "x".repeat(23) + "…",
    "a joined emoji that does not fit is dropped whole",
  );
});

/** The red, green and blue channels of a #rrggbb color. */
type Channels = [number, number, number];
function luminance(hex: string) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    // as Channels: mapping the three channel offsets gives three numbers
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Channels;
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (hex: string) => (luminance(hex) + 0.05) / (0.0053 + 0.05);
function hue(hex: string) {
  // as Channels: mapping the three channel offsets gives three numbers
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Channels,
    max = Math.max(r, g, b),
    d = max - Math.min(r, g, b);
  return d === 0 ? 0 : 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
}

test("overlay: readableColor leaves readable colors alone and lightens dark ones with the hue kept", () => {
  for (const ok of ["#ffffff", "#ff8800", "#00ff7f", "#1e90ff", "#ffd700"])
    assert.equal(readableColor(ok), ok, ok + " is already readable");
  for (const dark of ["#0000ff", "#000000", "#1a1a1a", "#8a2be2", "#2e0854", "#006400", "#800000", "#101040"]) {
    const out = readableColor(dark);
    assert.match(out, /^#[0-9a-f]{6}$/);
    assert.ok(contrast(out) >= 4.5, dark + " -> " + out + " contrast " + contrast(out).toFixed(2));
    assert.ok(luminance(out) >= luminance(dark), "never darker");
    if (dark !== "#000000" && dark !== "#1a1a1a")
      assert.ok(
        Math.abs(hue(out) - hue(dark)) < 8 || Math.abs(hue(out) - hue(dark)) > 352,
        "hue kept for " + dark + " -> " + out,
      );
  }
  assert.equal(readableColor("#0000FF"), readableColor("#0000ff"), "case does not matter");
  assert.equal(readableColor("nonsense"), "nonsense", "invalid values pass through for the caller to reject");
  // wrong type on purpose: the test checks that a missing color passes through
  assert.equal(readableColor(undefined as unknown as string), undefined);
});

test("overlay: the overlay version is the ?v= hash on its own script URL and on the overlay page", () => {
  const urls = {
    "https://pixfray.xyz/overlay.js?v=0123456789": "0123456789",
    "https://pixfray.xyz/overlay.js": "", // unbuilt (dev) overlay has no version
    "https://pixfray.xyz/overlay.js?v=nothex!": "",
    "not a url": "",
  };
  for (const [url, v] of Object.entries(urls)) assert.equal(overlayVersionFromUrl(url), v, url);
  const pages = [
    ['<script type="module" src="./overlay.js?v=abcdef0123"></script>', "abcdef0123"],
    ['<script src="./overlay.js"></script>', ""],
    ["", ""],
    [null, ""],
  ];
  for (const [html, v] of pages) assert.equal(overlayVersionFromHtml(html), v, String(html));
});
