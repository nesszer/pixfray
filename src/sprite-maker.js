// /play/ "Your own sprite": a picture becomes a pixel sprite in the browser (src/spritify.js), optionally redrawn by
// Workers AI first, and is sent to the mods (server/sprites.js). Once approved it is in the viewer's character list.
import { api, errorText, h, $, setStatus, CHANNEL } from "./ui.js";
import { decodeFile, decodeBase64, encode, fitSize, paint, spritify, REDRAW_MAX } from "./spritify.js";

const box = $("#sprite-maker"),
  canvas = $("#sprite-canvas"),
  status = $("#sprite-status");
const fileInput = $("#sprite-file"),
  nameInput = $("#sprite-name"),
  bgInput = $("#sprite-bg");
const aiBtn = $("#sprite-ai"),
  plainBtn = $("#sprite-plain"),
  sendBtn = $("#sprite-send");
const s = { source: null, redrawn: null, sprite: null, info: null, busy: false, onChange: () => {} };

const base = "/api/sprite/" + CHANNEL;
const name = (file) =>
  file.name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);

function render() {
  paint(canvas, s.sprite);
  $("#sprite-size").textContent = s.sprite ? s.sprite.width + " x " + s.sprite.height + " px" : "";
  const ai = s.info?.ai || { available: false, left: 0 };
  aiBtn.hidden = !ai.available;
  aiBtn.textContent = s.redrawn ? "Redraw again" : "Redraw with AI";
  aiBtn.disabled = s.busy || !s.source || ai.left <= 0;
  aiBtn.title = ai.left <= 0 ? "No AI redraws left today" : ai.left + " AI redraws left today";
  plainBtn.hidden = !s.redrawn;
  plainBtn.disabled = s.busy;
  bgInput.disabled = s.busy || Boolean(s.redrawn); // the AI draws on plain white, which always goes
  const left = s.info?.submitsLeft ?? 0;
  sendBtn.disabled = s.busy || !s.sprite || !nameInput.value.trim() || left <= 0;
  $("#sprite-note").textContent = s.info
    ? "(" + left + " sends left today" + (ai.available ? ", " + ai.left + " AI redraws" : "") + ")"
    : "";
}

function rebuild() {
  const from = s.redrawn || s.source;
  s.sprite = from ? spritify(from, { removeBg: Boolean(s.redrawn) || bgInput.checked }) : null;
  if (from && !s.sprite)
    setStatus(
      status,
      "Nothing was left after removing the background. Untick Remove the background, or try another picture.",
      "warning",
    );
  render();
}

function renderCurrent() {
  const cur = $("#sprite-current"),
    { live, pending, rejected } = s.info || {};
  const rows = [];
  if (live)
    rows.push(
      h("img", { class: "sprite-thumb", src: live.url, alt: live.label }),
      h(
        "p",
        { class: "small" },
        h("strong", {}, live.label),
        " is approved and in your character list (Channel originals).",
      ),
      h(
        "button",
        {
          class: "btn btn-small btn-danger",
          type: "button",
          onclick: () =>
            drop("live", "Remove " + live.label + "? You go back to the default character if you wear it."),
        },
        "Remove",
      ),
    );
  if (pending)
    rows.push(
      h("img", { class: "sprite-thumb", src: base + "/pending?t=" + pending.createdAt, alt: pending.label }),
      h("p", { class: "small" }, h("strong", {}, pending.label), " is waiting for a mod. Sending another replaces it."),
      h("button", { class: "btn btn-small", type: "button", onclick: () => drop("pending") }, "Withdraw"),
    );
  if (rejected)
    rows.push(
      h("p", { class: "small" }, "A mod turned down ", h("strong", {}, rejected.label), ". You can send another."),
    );
  cur.replaceChildren(...rows);
  cur.hidden = !rows.length;
}

async function refresh() {
  const r = await api(base);
  if (!r.ok) {
    box.hidden = true;
    return;
  }
  s.info = r.data;
  box.hidden = false;
  renderCurrent();
  render();
}

async function drop(kind, ask) {
  if (ask && !confirm(ask)) return;
  const r = await api(base + "/" + kind, { method: "DELETE" });
  setStatus(status, r.ok ? (kind === "live" ? "Sprite removed." : "Withdrawn.") : errorText(r), r.ok ? "ok" : "error");
  await refresh();
  if (kind === "live") s.onChange();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  s.busy = true;
  render();
  setStatus(status, "Reading the picture…");
  try {
    s.source = await decodeFile(file);
    s.redrawn = null;
    if (!nameInput.value.trim()) nameInput.value = name(file);
    setStatus(status, "");
  } catch (error) {
    s.source = null;
    setStatus(status, error.message, "error");
  }
  s.busy = false;
  rebuild();
});
bgInput.addEventListener("change", rebuild);
nameInput.addEventListener("input", render);
plainBtn.addEventListener("click", () => {
  s.redrawn = null;
  setStatus(status, "");
  rebuild();
});

aiBtn.addEventListener("click", async () => {
  if (!s.source) return;
  s.busy = true;
  render();
  setStatus(status, "Redrawing with AI. This takes about 10 seconds…");
  const { width, height } = fitSize(s.source.width, s.source.height, REDRAW_MAX);
  const small = width === s.source.width ? s.source : await shrinkTo(s.source, width, height);
  const r = await api(base + "/redraw", { method: "POST", body: { image: await encode(small, "image/jpeg") } });
  if (r.ok) {
    try {
      s.redrawn = await decodeBase64(r.data.image);
      s.info.ai.left = r.data.left;
      setStatus(status, "Redrawn. Send it, redraw again, or use your picture.", "ok");
    } catch {
      setStatus(status, "The AI's picture couldn't be opened. Try again.", "error");
    }
  } else {
    if (r.data?.reason === "ai_daily_limit" || r.data?.reason === "ai_channel_limit") s.info.ai.left = 0;
    setStatus(status, errorText(r), "error");
  }
  s.busy = false;
  rebuild();
});

async function shrinkTo(img, width, height) {
  const from = new OffscreenCanvas(img.width, img.height),
    to = new OffscreenCanvas(width, height);
  from.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const ctx = to.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(from, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

sendBtn.addEventListener("click", async () => {
  if (!s.sprite) return;
  s.busy = true;
  render();
  const r = await api(base, {
    method: "POST",
    body: { label: nameInput.value.trim(), image: await encode(s.sprite), ai: Boolean(s.redrawn) },
  });
  s.busy = false;
  if (!r.ok) {
    setStatus(status, errorText(r), "error");
    render();
    return;
  }
  setStatus(status, "Sent. A mod will check it; it shows in your character list once approved.", "ok");
  s.source = s.redrawn = s.sprite = null;
  fileInput.value = "";
  nameInput.value = "";
  await refresh();
});

// Shown to signed-in viewers on a channel that's on. onChange runs when the approved sprite goes away, so the page
// can reload the character list.
export function initSpriteMaker({ onChange } = {}) {
  s.onChange = onChange || s.onChange;
  return refresh();
}
