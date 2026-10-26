// /play/ "Your own sprite": a picture becomes a pixel sprite in the browser (src/spritify.ts), optionally redrawn by
// Workers AI first, and is sent to the mods (server/sprites.ts). Once approved it is in the viewer's character list.
import { api, errorText, h, $, setStatus, CHANNEL } from "./ui.ts";
import { decodeFile, decodeBase64, encode, paint, REDRAW_MAX, shrink } from "./spritify.ts";
import type { Img } from "./spritify.ts";
import type { SpriteDone, SpriteJob } from "./sprite-worker.ts";

const box = $<HTMLFieldSetElement>("#sprite-maker"),
  canvas = $<HTMLCanvasElement>("#sprite-canvas"),
  status = $("#sprite-status"),
  fileInput = $<HTMLInputElement>("#sprite-file"),
  nameInput = $<HTMLInputElement>("#sprite-name"),
  bgInput = $<HTMLInputElement>("#sprite-bg"),
  aiBtn = $<HTMLButtonElement>("#sprite-ai"),
  plainBtn = $<HTMLButtonElement>("#sprite-plain"),
  sendBtn = $<HTMLButtonElement>("#sprite-send");
/** GET /api/sprite/:channel (server/sprites.ts), the fields read here. */
type SpriteInfo = {
  live?: { url: string; label: string } | null;
  pending?: { label: string; createdAt: number } | null;
  rejected?: { label: string } | null;
  submitsLeft?: number;
  ai: { available: boolean; left: number };
};
const s: {
  source: Img | null;
  redrawn: Img | null;
  sprite: Img | null;
  info: SpriteInfo | null;
  busy: boolean;
  onChange: () => void;
} = { source: null, redrawn: null, sprite: null, info: null, busy: false, onChange: () => {} };

const base = "/api/sprite/" + CHANNEL;
const name = (file: File) =>
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

// Finding the subject can take a second, so the sprite is built in a worker and the page stays responsive. A newer
// build replaces an older one still running: only the answer to the latest job is used.
const worker = new Worker(new URL("./sprite-worker.ts", import.meta.url), { type: "module" });
let job = 0;
worker.onmessage = ({ data }: MessageEvent<SpriteDone>) => {
  if (data.id !== job) return;
  s.busy = false;
  s.sprite = data.sprite;
  if (!s.sprite)
    setStatus(
      status,
      "Nothing was left after removing the background. Untick Remove the background, or try another picture.",
      "warning",
    );
  render();
};
worker.onerror = () => {
  job++;
  s.busy = false;
  setStatus(status, "The sprite couldn't be made. Reload the page and try again.", "error");
  render();
};

function rebuild() {
  const from = s.redrawn || s.source,
    id = ++job;
  s.sprite = null;
  s.busy = Boolean(from);
  if (from) {
    const { width, height, data } = from,
      msg: SpriteJob = { id, img: { width, height, data }, removeBg: Boolean(s.redrawn) || bgInput.checked };
    worker.postMessage(msg);
  }
  render();
}

async function refresh() {
  const r = await api(base);
  if (!r.ok) {
    box.hidden = true;
    return;
  }
  s.info = r.data;
  box.hidden = false;
  const cur = $("#sprite-current"),
    { live, pending, rejected }: Partial<SpriteInfo> = s.info || {};
  const rows: HTMLElement[] = [];
  if (live) {
    const ask = "Remove " + live.label + "? You go back to the default character if you wear it.";
    rows.push(
      h("img", { class: "sprite-thumb", src: live.url, alt: live.label }),
      h(
        "p",
        { class: "small" },
        h("strong", {}, live.label),
        " is approved and in your character list (Channel originals).",
      ),
      h("button", { class: "btn btn-small btn-danger", type: "button", onclick: () => drop("live", ask) }, "Remove"),
    );
  }
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
  render();
}

async function drop(kind: string, ask?: string) {
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
    setStatus(status, (error as Error).message, "error"); // decodeFile throws only Errors
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
  const image = await encode(shrink(s.source, REDRAW_MAX), "image/jpeg");
  const r = await api(base + "/redraw", { method: "POST", body: { image } });
  if (r.ok) {
    try {
      s.redrawn = await decodeBase64(r.data.image);
      s.info!.ai.left = r.data.left; // the AI button is enabled only after refresh() stored the info
      setStatus(status, "Redrawn. Send it, redraw again, or use your picture.", "ok");
    } catch {
      setStatus(status, "The AI's picture couldn't be opened. Try again.", "error");
    }
  } else {
    // s.info!: the AI button is enabled only after refresh() stored the info
    if (r.data?.reason === "ai_daily_limit" || r.data?.reason === "ai_channel_limit") s.info!.ai.left = 0;
    setStatus(status, errorText(r), "error");
  }
  s.busy = false;
  rebuild();
});

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
export function initSpriteMaker({ onChange }: { onChange?: () => void } = {}) {
  s.onChange = onChange || s.onChange;
  return refresh();
}
