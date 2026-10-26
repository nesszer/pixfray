// Fighter tab: builds, upgrades, the character grid and colors, plus the on-stream preview and what it wears.
import { h, $, button } from "../ui.ts";
import {
  bonusHp,
  counterChance,
  emptyStats,
  levelCost,
  presetReady,
  presetStats,
  spentOn,
  statValue,
  PRESETS,
} from "../../server/upgrades.ts";
import type { Stat } from "../../server/upgrades.ts";
import { CHARACTER_GROUPS } from "../character-groups.ts";
import {
  state,
  stage,
  render3d,
  vox,
  thumb,
  peekOn,
  rules,
  loadoutOf,
  copy,
  activeBuild,
  canShop,
  entryOf,
  petById,
  pickable,
  petBoost,
  looks,
  owns,
  itemLabel,
  money,
} from "./state.ts";
import type { CatalogEntry, ItemKind, Loadout } from "./state.ts";
import { buyButton, lookSprites, lookVox } from "./shop.ts";
import { renderAll } from "../dashboard.ts";
import { renderSave } from "./save.ts";

const colorInput = $<HTMLInputElement>("#color"),
  playBtn = $<HTMLButtonElement>("#play-win");
// Builds: one free slot, more for dollars. Each keeps its own loadout; saving one puts it on stream.
export function switchBuild(slot: number, start: Loadout | null = null) {
  state.drafts[state.slot] = copy(state.d);
  state.slot = slot;
  state.d = state.drafts[slot] || start || (state.builds[slot] ? loadoutOf(state.builds[slot]) : copy(state.d));
  if (start) state.drafts[slot] = state.d;
}
export function renderBuilds() {
  const box = $<HTMLFieldSetElement>("#builds"),
    slots = state.owned.slots || 1,
    max = state.shop?.slots?.max || 5;
  box.hidden = !canShop();
  if (box.hidden) return;
  const price = slots < max ? state.shop?.slots?.prices?.[slots - 1] : null;
  $<HTMLDivElement>("#build-list").replaceChildren(
    ...Array.from({ length: slots }, (_, i) => {
      const b = state.builds[i];
      return h(
        "button",
        {
          type: "button",
          class: "build",
          "aria-pressed": String(i === state.slot),
          onclick: () => {
            if (i === state.slot) return;
            switchBuild(i);
            renderAll();
          },
        },
        h("strong", {}, "Build " + (i + 1)),
        h(
          "span",
          { class: "muted small" },
          i === activeBuild() ? "On stream" : b ? entryOf(b.avatar)?.label || b.avatar : "Not saved yet",
        ),
      );
    }),
    ...(price
      ? [
          buyButton(
            "slot",
            "",
            "build slot " + (slots + 1),
            price,
            $<HTMLParagraphElement>("#status-slot"),
            "Add build " + (slots + 1) + " for $" + price,
          ),
        ]
      : []),
  );
  $("#build-note").textContent = "(" + slots + " of " + max + ")";
}

// A stat's effect at a level as a percentage, to one decimal above level 8 where the steps shrink.
const pct = (k: Stat, n: number) => Math.round(statValue(k, n) * 1000) / 10 + "%";
const STAT_TEXT = {
  power: { label: "Power", effect: (n: number) => "+" + pct("power", n) + " damage dealt" },
  guard: { label: "Guard", effect: (n: number) => "−" + pct("guard", n) + " damage taken" },
  luck: { label: "Luck", effect: (n: number) => pct("luck", n) + " of misses still hit" },
  crit: { label: "Crit", effect: (n: number) => pct("crit", n) + " of hits become crits" },
  dodge: { label: "Dodge", effect: (n: number) => pct("dodge", n) + " of hits on you miss" },
  counter: {
    label: "Counter",
    effect: (n: number) =>
      "+" +
      pct("counter", n) +
      " counter damage, " +
      Math.round(counterChance(n) * 1000) / 10 +
      "% of foe misses countered",
  },
  vitality: { label: "Vitality", effect: (n: number) => "+" + bonusHp(n) + " max HP in duels" },
};
const points = (n: number) => n + (n === 1 ? " point" : " points");
export function renderUpgrades() {
  const r = rules(),
    canEdit = canShop();
  const left = r.points - spentOn(state.d.stats);
  $("#points-note").textContent = canEdit ? "(" + left + " of " + r.points + " points free)" : "";
  const parts = [
    r.fromWins + " from wins",
    r.fromCheckins ? r.fromCheckins + " from check-ins" : "",
    r.fromLosses ? r.fromLosses + " from losses" : "",
  ].filter(Boolean);
  const from = parts.length > 1 ? " You have " + parts.slice(0, -1).join(", ") + " and " + parts.at(-1) + "." : "";
  $("#upgrades-help").textContent = canEdit
    ? "Each win, each stream check-in (!checkin in chat) and every " +
      r.lossesPerPoint +
      " losses give a point. Levels 1 to 8 cost 1 point each, and the cost doubles every 8 levels after that. Levels above " +
      r.maxLevel +
      " don't count on this channel." +
      from +
      " Move points between stats whenever you're not in a duel."
    : "Save your fighter, then each win, each stream check-in (!checkin in chat) and every " +
      r.lossesPerPoint +
      " losses give an upgrade point.";
  const shown = canEdit ? state.d.stats : emptyStats();
  const link = $<HTMLAnchorElement>("#points-link");
  link.hidden = !canEdit || left <= 0;
  link.textContent = left + (left === 1 ? " upgrade point" : " upgrade points") + " to spend";
  const restat = (stats: typeof shown) => {
    state.d.stats = stats;
    renderUpgrades();
    renderSave();
  };
  $<HTMLDivElement>("#upgrade-list").replaceChildren(
    ...r.stats.map((k) => {
      const t = STAT_TEXT[k],
        n = shown[k],
        counted = Math.min(n, r.maxLevel),
        extra = petBoost(petById(state.d.pet))?.[k] || 0,
        total = counted + extra,
        cost = levelCost(n + 1),
        atCap = n >= r.maxLevel;
      const step = (d: number) => () => restat({ ...state.d.stats, [k]: state.d.stats[k] + d });
      // The plain effect of everything the fighter has in this stat, pet included.
      const effect = total
        ? t.effect(total) + (extra ? " (" + extra + " from your pet)" : "")
        : t.effect(1) + " per level";
      // Why "+" is off, or what it costs, in quiet text next to the stat.
      const next = !canEdit
        ? ""
        : atCap
          ? n > r.maxLevel
            ? "Levels above " + r.maxLevel + " don't count here"
            : "Highest level on this channel"
          : "Next level costs " + points(cost);
      return h(
        "div",
        { class: "upgrade" },
        h(
          "div",
          { class: "upgrade-name" },
          h("strong", {}, t.label),
          h("span", { class: "muted small" }, effect),
          next ? h("span", { class: "muted small" }, next) : null,
          // one cell per level up to the channel's cap, the pet's bonus in a lighter tone after them
          h(
            "span",
            { class: "meter", "aria-hidden": "true" },
            ...Array.from({ length: Math.min(Math.max(r.maxLevel, total), 24) }, (_, i) =>
              h("i", { class: i < counted ? "on" : i < total ? "pet" : "" }),
            ),
          ),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            "aria-label": "Take a level out of " + t.label + ", refunds " + points(levelCost(n)),
            disabled: !canEdit || n <= 0,
            onclick: step(-1),
          },
          "−",
        ),
        h(
          "span",
          { class: "upgrade-value num", title: extra ? "+" + extra + " from your pet" : null },
          n + " / " + r.maxLevel + (extra ? " +" + extra : ""),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            "aria-label": "Put a level into " + t.label + " for " + points(cost),
            disabled: !canEdit || cost > left || atCap,
            onclick: step(1),
          },
          "+",
        ),
      );
    }),
  );
  // Suggested builds: each spreads all the points by its weights; the viewer still presses Save profile.
  const presets = $<HTMLDivElement>("#upgrade-presets");
  presets.hidden = !canEdit;
  presets.replaceChildren(
    ...PRESETS.filter(presetReady).map((preset) =>
      button(preset.label, () => restat(presetStats(preset, r.points, r.maxLevel))),
    ),
  );
}

// Characters: search by name, filter by group; unfiltered, the list starts with 12 (plus the picked one).
const groupsOf = (entry: CatalogEntry) =>
  entry.custom ? ["custom"] : CHARACTER_GROUPS.filter((g) => g.ids.includes(entry.id)).map((g) => g.id);
const grid = $<HTMLDivElement>("#characters"),
  more = $<HTMLButtonElement>("#more-chars");
export function renderCharacters() {
  const list = pickable();
  if (!list.length)
    return grid.replaceChildren(
      h("p", { class: "muted small" }, "No characters are available right now. Reload to try again."),
    );
  $("#char-count").textContent = "(" + list.length + " available)";
  const groups = [
    { id: "all", label: "All" },
    ...CHARACTER_GROUPS.filter((g) => list.some((e) => groupsOf(e).includes(g.id))),
    ...(list.some((e) => e.custom) ? [{ id: "custom", label: "Channel originals" }] : []),
  ];
  $<HTMLDivElement>("#char-groups").replaceChildren(
    ...groups.map((g) =>
      button(
        g.label,
        () => {
          state.filter.group = g.id;
          filterCharacters();
        },
        { "data-group": g.id, "aria-pressed": String(g.id === state.filter.group) },
      ),
    ),
  );
  grid.replaceChildren(
    ...list.map((entry) => {
      const id = "char-" + entry.id;
      const input = h("input", { type: "radio", name: "character", id, value: entry.id });
      input.addEventListener("change", () => {
        state.d.avatar = entry.id;
        renderPreview();
        renderSave();
      });
      let hover = false;
      const option = h(
        "div",
        {
          class: "char-option",
          "data-groups": groupsOf(entry).join(" "),
          "data-name": (entry.label || entry.id).toLowerCase() + " " + entry.id,
          onpointerenter: () => (hover = true),
          onpointerleave: () => (hover = false),
        },
        input,
        h(
          "label",
          { for: id },
          thumb(entry, 64, { anim: "walk", active: () => hover || input.checked || document.activeElement === input }),
          h("span", {}, entry.label || entry.id),
          entry.owner || entry.custom
            ? h("span", { class: "tag" }, entry.owner ? "Your sprite" : "Channel original")
            : null,
        ),
      );
      peekOn(option, "avatar", entry.id);
      return option;
    }),
  );
  filterCharacters();
}
function filterCharacters() {
  const q = state.filter.q.trim().toLowerCase(),
    g = state.filter.group,
    filtered = Boolean(q) || g !== "all";
  let shown = 0;
  // the grid's children are HTML elements (tiles, or the empty note)
  for (const option of grid.children as HTMLCollectionOf<HTMLElement>) {
    const match =
      (!q || option.dataset.name?.includes(q)) && (g === "all" || option.dataset.groups?.split(" ").includes(g));
    option.hidden = !match;
    if (match) shown++;
  }
  // as: the group row holds only buttons
  for (const b of $("#char-groups").children as HTMLCollectionOf<HTMLButtonElement>)
    b.setAttribute("aria-pressed", String(b.dataset.group === g));
  $("#char-empty").hidden = shown > 0;
  more.hidden = filtered || grid.children.length <= 12;
  if (filtered) grid.classList.remove("collapsed");
  else showAllChars(more.getAttribute("aria-expanded") === "true");
}
$<HTMLInputElement>("#char-search").addEventListener("input", (e) => {
  // as: the input event's target is that input
  state.filter.q = (e.target as HTMLInputElement).value;
  filterCharacters();
});
function showAllChars(all: boolean) {
  grid.classList.toggle("collapsed", !all);
  more.setAttribute("aria-expanded", String(all));
  more.textContent = all ? "Show fewer characters" : "Show all " + grid.children.length + " characters";
}
more.addEventListener("click", () => showAllChars(grid.classList.contains("collapsed")));

const SWATCHES = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#e5e7eb", "#22d3ee"];
const recolor = (color: string) => {
  state.d.color = color;
  renderPreview();
  renderSave();
};
export function renderSwatches() {
  const box = $<HTMLDivElement>("#swatches");
  box.querySelectorAll(".swatch").forEach((n) => n.remove());
  for (const color of SWATCHES)
    box.insertBefore(
      h("button", {
        type: "button",
        class: "swatch",
        style: { background: color },
        "aria-label": "Nameplate color " + color,
        "aria-pressed": "false",
        "data-color": color,
        onclick: () => recolor(color),
      }),
      box.querySelector(".custom-color"),
    );
}
colorInput.addEventListener("input", () => recolor(colorInput.value.toLowerCase()));

export function renderPreview() {
  const d = state.d,
    entry = entryOf(d.avatar),
    user = state.session?.user,
    name = user?.displayName || user?.login || "you",
    elo = state.profile?.elo ?? state.config?.initialElo ?? 1000;
  stage.set({ entry, hat: d.hat, pet: petById(d.pet), color: d.color, name, elo, looks: looks(d) });
  render3d();
  const plate = $("#showcase-plate");
  plate.textContent = name + " · " + elo;
  plate.style.setProperty("--plate", d.color);
  if (lookSprites.entry !== entry) {
    lookSprites.entry = entry;
    for (const s of lookSprites) s.set(entry);
    for (const [v, make] of lookVox) if (v.isConnected) vox(v, make);
  }
  for (const s of document.querySelectorAll<HTMLButtonElement>(".swatch"))
    s.setAttribute("aria-pressed", String(s.dataset.color === d.color));
  colorInput.value = d.color;
  const several = (state.owned.slots || 1) > 1;
  $("#preview-caption").textContent =
    (entry ? entry.label || entry.id : "") + (several ? " · Build " + (state.slot + 1) : "");
  const words = [
    entry?.label,
    d.hat && itemLabel("hat", d.hat),
    d.accessory && itemLabel("accessory", d.accessory),
    d.recolor && itemLabel("recolor", d.recolor) + " colors",
    d.pet && "with " + itemLabel("pet", d.pet),
    d.trail && itemLabel("trail", d.trail) + " trail",
    d.title && "title " + itemLabel("title", d.title),
  ].filter(Boolean);
  $("#preview").setAttribute(
    "aria-label",
    "Preview of your fighter on stream: " + (words.join(", ") || "no character yet"),
  );
  // nothing to preview yet: point to the Shop instead
  playBtn.disabled = !d.winEffect && !d.taunt;
  playBtn.hidden = playBtn.disabled;
  $("#win-link").hidden = !playBtn.disabled;
  renderLoadout();
}
// on phones the on-stream strip is tucked over the 3D stage and only shows while a win plays
let playing = 0;
export function playWin() {
  stage.play();
  const fig = $(".hero-card .preview");
  fig.classList.add("is-playing");
  clearTimeout(playing);
  playing = setTimeout(() => fig.classList.remove("is-playing"), 4500);
}
playBtn.addEventListener("click", playWin);
// Desktop: what the fighter wears, under the preview. Items only tried on show their price; the total is what
// buying the look costs.
const priceOf = (kind: ItemKind, id: string) =>
  kind === "hat"
    ? (state.shop?.hatPricePerWin || 0) * (rules().hats.find((x) => x.id === id)?.wins || 0)
    : kind === "pet"
      ? petById(id)?.price || 0
      : state.shop?.items?.[kind]?.find((x) => x.id === id)?.price || 0;
// An empty slot links to where it's filled, instead of reading "None".
const EMPTY: Partial<Record<ItemKind, [string, string]>> = {
  hat: ["hats", "Add a hat"],
  pet: ["pets", "Add a pet"],
  accessory: ["shop-accessory", "Add an accessory"],
  trail: ["shop-trail", "Add a trail"],
  effect: ["win-effects", "Add a win effect"],
  title: ["shop-title", "Add a title"],
};
function renderLoadout() {
  const box = $<HTMLDListElement | null>("#loadout");
  if (!box) return;
  const d = state.d,
    entry = entryOf(d.avatar);
  const rows: [string, ItemKind | null, string][] = [
    ["Character", null, d.avatar],
    ["Colors", "recolor", d.recolor],
    ["Hat", "hat", d.hat],
    ["Accessory", "accessory", d.accessory],
    ["Pet", "pet", d.pet],
    ["Trail", "trail", d.trail],
    ["Win effect", "effect", d.winEffect],
    ["Title", "title", d.title],
  ];
  let total = 0;
  box.replaceChildren(
    ...rows.flatMap(([label, kind, id]) => {
      const empty = kind && !id && EMPTY[kind];
      if (empty)
        return [h("dt", {}, label), h("dd", {}, h("a", { class: "slot-empty", href: "#" + empty[0] }, empty[1]))];
      const value = !kind
        ? entry?.label || entry?.id || "None"
        : id
          ? kind === "hat"
            ? itemLabel("hat", id).replace(/ hat$/, "")
            : itemLabel(kind, id)
          : "Original";
      const price = kind && id && !owns(kind, id) ? priceOf(kind, id) : 0;
      total += price;
      return [
        h("dt", {}, label),
        h(
          "dd",
          { class: id ? null : "muted" },
          value,
          price ? h("span", { class: "badge" }, "Try-on " + money(price)) : "",
        ),
      ];
    }),
  );
  const t = $("#loadout-total");
  t.hidden = !total;
  t.textContent = total ? "Buying this look costs " + money(total) + ". Duels earn PixFray dollars." : "";
}
