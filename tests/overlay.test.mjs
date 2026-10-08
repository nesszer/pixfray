// Pure helpers of the OBS overlay (public/overlay.js): limits, text cutting, name colors, version parsing.
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
} from "../public/overlay.js";

test("overlay: parseCap floors, clamps to 100 and falls back for anything below 1 or not a number", () => {
  assert.equal(parseCap("8"), 8);
  assert.equal(parseCap("8.9"), 8);
  assert.equal(parseCap("1"), 1);
  assert.equal(parseCap("100"), 100);
  assert.equal(parseCap("250"), 100);
  for (const bad of [null, undefined, "", "abc", "0", "0.5", "-3", "NaN", "Infinity", "1e999"]) {
    assert.equal(parseCap(bad), 100, "default for " + String(bad));
  }
  assert.equal(parseCap("abc", 40), 40, "a custom default is used");
});

test("overlay: effectiveCap is the lower of the link cap and the channel limit", () => {
  assert.equal(effectiveCap(8, 15), 8, "link cap lower than the channel limit wins");
  assert.equal(effectiveCap(40, 15), 15, "channel limit lower than the link cap wins");
  assert.equal(effectiveCap(100, 50), 50, "no link cap: the channel limit applies");
  assert.equal(effectiveCap(8, undefined), 8, "no channel limit yet");
  assert.equal(effectiveCap(undefined, undefined), 100);
  assert.equal(effectiveCap(8, 0), 1, "never below 1");
  assert.equal(effectiveCap(8, 500), 8, "channel limit is clamped to 100");
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

function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (hex) => (luminance(hex) + 0.05) / (0.0053 + 0.05);
function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255),
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
  assert.equal(readableColor(undefined), undefined);
});

test("overlay: the overlay version is the ?v= hash on its own script URL and on the overlay page", () => {
  assert.equal(overlayVersionFromUrl("https://pixfray.xyz/overlay.js?v=0123456789"), "0123456789");
  assert.equal(overlayVersionFromUrl("https://pixfray.xyz/overlay.js"), "", "unbuilt (dev) overlay has no version");
  assert.equal(overlayVersionFromUrl("https://pixfray.xyz/overlay.js?v=nothex!"), "");
  assert.equal(overlayVersionFromUrl("not a url"), "");
  const html = '<script type="module" src="./overlay.js?v=abcdef0123"></script>';
  assert.equal(overlayVersionFromHtml(html), "abcdef0123");
  assert.equal(overlayVersionFromHtml('<script src="./overlay.js"></script>'), "");
  assert.equal(overlayVersionFromHtml(""), "");
  assert.equal(overlayVersionFromHtml(null), "");
});
