// The Characters tab: custom character slots, viewer sprites to review, custom pets, and the upload tool.
import { api, errorText, h, $, setStatus, dateTime, on, onSubmit, busy, button, dataTable, CHANNEL } from "../ui.ts";
import { formatBytes, LIMITS } from "../served/atlas.ts";
import { admin, load } from "./state.ts";
// Shapes of the /api/assets, /api/pets and /api/sprites bodies; each place that keeps one casts it once.
type CustomItem = {
  id: string;
  label?: string;
  frames?: unknown[];
  animations?: Record<string, unknown[]>;
  bytes?: number;
  createdAt: number;
};
type Pet = {
  id: string;
  label: string;
  custom?: boolean;
  url: string;
  tier: string;
  boost?: Record<string, number | undefined>;
  price: number;
};
type Sprite = {
  id: string;
  label: string;
  displayName?: string;
  username?: string;
  ai?: boolean;
  createdAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
};

// ---------- custom characters ----------
let customItems: CustomItem[] | null = null,
  customLimits: unknown = null;
export function renderUsage() {
  const u = admin().customUsage || { count: 0, limit: LIMITS.maxCharacters, bytes: 0 };
  const limit = u.limit || LIMITS.maxCharacters,
    budget = limit * LIMITS.maxAtlasBytes;
  $("#usage-title").textContent = u.count + " of " + limit + " custom character slots used";
  // the title already counts the slots
  $("#usage-bars").replaceChildren(
    h("div", { class: "bar-label" }, "Atlas storage"),
    h(
      "div",
      { class: "bar is-key", style: { "--v": Math.min(100, (u.bytes / budget) * 100) + "%" } },
      h("span"),
      h("b", {}, formatBytes(u.bytes) + " / " + formatBytes(budget)),
    ),
  );
}
export async function loadCustom() {
  const r = await api("/api/assets/" + CHANNEL);
  const box = $("#custom-list");
  if (!r.ok) return box.replaceChildren(h("p", {}, "Couldn't list custom characters: " + errorText(r)));
  // /api/assets/:channel body
  customItems = (r.data.items || []) as CustomItem[];
  customLimits = r.data.limits || null;
  box.replaceChildren(
    customItems.length
      ? dataTable(
          ["Character", "Frames", "Size", "Added"],
          customItems.map((x) => [
            x.label || x.id,
            (x.frames || []).length + Object.values(x.animations || {}).reduce((n, f) => n + f.length, 0),
            formatBytes(x.bytes || 0),
            dateTime(x.createdAt),
          ]),
          [1, 2],
        )
      : h("p", {}, "No custom characters yet. The slots are shared by the broadcaster and all moderators."),
  );
}

// ---------- viewer sprites (server/sprites.ts): approve or turn down what viewers sent; remove approved ones ----------
export async function loadSprites() {
  const r = await api("/api/sprites/" + CHANNEL),
    pendingBox = $("#sprite-pending"),
    liveBox = $("#sprite-live");
  if (!r.ok) {
    pendingBox.replaceChildren(h("p", { class: "muted small" }, "Couldn't list viewer sprites: " + errorText(r)));
    liveBox.replaceChildren();
    return;
  }
  // /api/sprites/:channel body
  const { pending = [], live = [] } = r.data as { pending?: Sprite[]; live?: Sprite[] };
  $("#sprite-count").textContent = "(" + pending.length + ")";
  $("#tab-characters").textContent = pending.length ? "Characters (" + pending.length + ")" : "Characters";
  const thumb = (x: Sprite) =>
    h("img", {
      class: "sprite-thumb",
      src: "/api/sprites/" + CHANNEL + "/" + x.id,
      alt: x.label,
      width: 64,
      height: 64,
      loading: "lazy",
    });
  // the login only when it isn't just the display name in other letter case
  const who = (x: Sprite) => [
    x.displayName || x.username,
    x.displayName && x.username && x.displayName.toLowerCase() !== x.username.toLowerCase()
      ? [h("br"), h("span", { class: "muted small" }, x.username)]
      : null,
  ];
  const review = (x: Sprite, action: "approve" | "reject" | "remove", text: string, cls = "btn btn-small") =>
    button(text, (b) => reviewSprite(x, action, b), { class: cls });
  pendingBox.replaceChildren(
    pending.length
      ? dataTable(
          ["Sprite", "Name", "Viewer", "Made with", "Sent", ""],
          pending.map((x) => [
            thumb(x),
            x.label,
            who(x),
            x.ai ? "AI redraw" : "Pixel filter",
            dateTime(x.createdAt),
            h(
              "div",
              { class: "toolbar" },
              review(x, "approve", "Approve"),
              review(x, "reject", "Turn down", "btn btn-small btn-danger"),
            ),
          ]),
        )
      : h("p", { class: "muted small" }, "Nothing waiting."),
  );
  liveBox.replaceChildren(
    live.length
      ? dataTable(
          ["Sprite", "Name", "Viewer", "Approved by", "Approved", ""],
          live.map((x) => [
            thumb(x),
            x.label,
            who(x),
            x.reviewedBy,
            dateTime(x.reviewedAt),
            review(x, "remove", "Remove", "btn btn-small btn-danger"),
          ]),
        )
      : h("p", { class: "muted small" }, "None yet."),
  );
}
async function reviewSprite(x: Sprite, action: "approve" | "reject" | "remove", b: HTMLButtonElement) {
  const ask = `Remove ${x.label}? ${x.displayName} goes back to the default character if they wear it.`;
  if (action === "remove" && !confirm(ask)) return;
  const r = await busy(b, () => api("/api/sprites/" + CHANNEL + "/" + x.id, { method: "POST", body: { action } }));
  const done = {
    approve: x.label + " approved and put on " + x.displayName + "'s fighter.",
    reject: x.label + " turned down.",
    remove: x.label + " removed.",
  }[action];
  const failed = `Couldn't ${action === "reject" ? "turn it down" : action}: ${errorText(r)}.`;
  setStatus($("#sprite-review-status"), r.ok ? done : failed, r.ok ? "ok" : "error");
  loadSprites();
}

// ---------- custom pets ----------
// Uploaded pets join the shop at their tier's price (server/pets.ts). Built-in pets are drawn in code and can't be removed.
// A custom pet's boost. A legendary rolls its stats for each owner, so the table says so instead of a number.
const boostLabel = (tier: string, b: Record<string, number | undefined> | undefined) =>
  tier === "legendary"
    ? "+1 to 4 random stats"
    : ["power", "guard", "luck"]
        .filter((k) => b?.[k])
        // b!: the filter kept only stats b has
        .map((k) => "+" + b![k] + " " + k)
        .join(", ");
export async function loadPets() {
  const r = await api("/api/pets/" + CHANNEL),
    box = $("#pet-custom-list");
  if (!r.ok) return box.replaceChildren(h("p", { class: "muted small" }, "Couldn't list pets: " + errorText(r)));
  // /api/pets/:channel body
  const custom = ((r.data.pets || []) as Pet[]).filter((p) => p.custom),
    max = r.data.limits?.maxPets || 24;
  $("#pet-count").textContent = "(" + custom.length + " of " + max + ")";
  box.replaceChildren(
    custom.length
      ? dataTable(
          ["Pet", "Tier", "Boost", "Price ($)", ""],
          custom.map((p) => [
            [h("img", { class: "pet-thumb", src: p.url, alt: "", width: 32, height: 32 }), " " + p.label],
            p.tier.charAt(0).toUpperCase() + p.tier.slice(1), // server/pets.ts only takes the five tiers
            boostLabel(p.tier, p.boost),
            p.price,
            button("Delete", (b) => deletePet(p, b), { class: "btn btn-small btn-danger" }),
          ]),
          [3],
        )
      : h("p", { class: "muted small" }, "No custom pets yet. Viewers can buy the 14 built-in pets."),
  );
}
async function deletePet(p: Pet, b: HTMLButtonElement) {
  if (!confirm("Delete " + p.label + "? Fighters who bought it lose it, and no dollars are refunded.")) return;
  const r = await busy(b, () => api("/api/pets/" + CHANNEL + "/" + p.id, { method: "DELETE" }));
  const text = r.ok ? p.label + " deleted." : "Couldn't delete: " + errorText(r) + ".";
  setStatus($("#pet-upload-status"), text, r.ok ? "ok" : "error");
  if (r.ok) loadPets();
}
function syncPetStats() {
  const tier = $<HTMLSelectElement>("#pet-tier").value;
  $("#pet-stat-wrap").hidden = tier === "legendary";
  $("#pet-stat2-wrap").hidden = tier !== "epic";
}
on<HTMLSelectElement>("#pet-tier", syncPetStats, "change");
onSubmit("#pet-form", async () => {
  const status = $("#pet-upload-status"),
    // a file input always has a FileList; element type from the page HTML
    file = $<HTMLInputElement>("#pet-file").files![0],
    label = $<HTMLInputElement>("#pet-label").value.trim(),
    tier = $<HTMLSelectElement>("#pet-tier").value;
  const stat = $<HTMLSelectElement>("#pet-stat").value,
    stat2 = $<HTMLSelectElement>("#pet-stat2").value;
  if (!file) return setStatus(status, "Choose a PNG image.", "error");
  if (file.type !== "image/png") return setStatus(status, "The image must be a PNG.", "error");
  if (file.size > 65536) return setStatus(status, "The image is larger than 64 KB.", "error");
  if (!label) return setStatus(status, "Name the pet.", "error");
  if (tier === "epic" && stat === stat2) return setStatus(status, "Epic pets boost two different stats.", "error");
  const image = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  setStatus(status, "Uploading…");
  const r = await busy($<HTMLButtonElement>("#pet-upload"), () =>
    api("/api/pets/" + CHANNEL, { method: "POST", body: { label, tier, stat, stat2, image } }),
  );
  if (!r.ok) return setStatus(status, "Not uploaded: " + errorText(r) + ".", "error");
  setStatus(status, label + " is in the shop now.", "ok");
  $<HTMLFormElement>("#pet-form").reset();
  syncPetStats();
  loadPets();
});

// Lane D hook: src/served/upload.ts may export mountUpload(root, ctx). Probe first so a missing file stays quiet.
export async function mountUploads() {
  const root = $("#upload-root");
  try {
    const probe = await fetch("/upload.js", { method: "HEAD" });
    if (!probe.ok || !/javascript/.test(probe.headers.get("Content-Type") || "")) return;
    const url = new URL("/upload.js", location.origin).href; // absolute, so Vite dev doesn't rewrite it to /upload.js?import
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.mountUpload !== "function") return;
    root.replaceChildren();
    root.classList.remove("mount"); // the uploader brings its own frame
    await mod.mountUpload(root, {
      channel: CHANNEL,
      usage: admin().customUsage,
      limits: customLimits || LIMITS,
      items: customItems || [],
      refresh: async () => {
        await Promise.all([load(), loadCustom()]);
      },
    });
  } catch (error) {
    root.replaceChildren(
      h(
        "p",
        { class: "status error" },
        // anything can be thrown
        "The upload tool failed to load: " + ((error as { message?: unknown } | null | undefined)?.message || error),
      ),
    );
  }
}
