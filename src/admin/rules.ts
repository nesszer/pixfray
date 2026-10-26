// The Rules tab: the channel config editor (docs/CONTRACTS.md section 7) and its version history.
import { errorText, h, $, setStatus, seconds, dateTime, onSubmit, on, button, row } from "../ui.ts";
import type { Admin, AdminConfig as Config } from "../parse.ts";
import { S, admin, liveChat, nameOf, act, post, load, fillTable } from "./state.ts";

type NumberField = { key: string; label: string; unit: string; min: number; max: number; ms?: true; bool?: never };
type BoolField = { key: string; label: string; bool: true; hint: string; ms?: never; unit?: never };
type Field = NumberField | BoolField;
type Label = { key?: string; label: string; unit?: string; min?: number; max?: number; ms?: true; bool?: true };
// Editable config fields. `ms` fields are edited in seconds and sent as integer ms.
const GROUPS: { title: string; visible?: (config: Config, admin: Admin) => boolean; fields: Field[] }[] = [
  {
    title: "Health and duels",
    fields: [
      { key: "maxHp", label: "Max health", unit: "HP", min: 1, max: 1000 },
      { key: "maxDuels", label: "Duels at the same time", unit: "duels", min: 1, max: 5 },
      { key: "challengeTimeoutMs", label: "Challenge expires after", unit: "s", ms: true, min: 5000, max: 300000 },
      { key: "inactivityMs", label: "Idle duel cancelled after", unit: "s", ms: true, min: 10000, max: 600000 },
      { key: "respawnMs", label: "Respawn after knockout", unit: "s", ms: true, min: 0, max: 60000 },
      { key: "rematchDelayMs", label: "Rematch wait", unit: "s", ms: true, min: 0, max: 600000 },
      { key: "streamDelayMs", label: "Stream delay", unit: "s", ms: true, min: 0, max: 60000 },
    ],
  },
  {
    title: "Ranking",
    fields: [
      { key: "initialElo", label: "Starting Elo", unit: "Elo", min: 0, max: 10000 },
      { key: "eloK", label: "Elo K-factor", unit: "K", min: 1, max: 100 },
      {
        key: "pairRankedPerStream",
        label: "Ranked duels per pair each stream (0: no limit)",
        unit: "duels",
        min: 0,
        max: 50,
      },
    ],
  },
  // !checkin (server/channel.ts checkin) and how far upgrade levels count here (server/upgrades.ts effectiveStats).
  {
    title: "Check-ins",
    fields: [
      { key: "checkinPoints", label: "Upgrade points per check-in", unit: "points", min: 0, max: 3 },
      {
        key: "streakBonus",
        label: "Streak bonus",
        bool: true,
        hint: "+1 point at a streak of 3, 7, 14 and 30 streams, +2 at 60, +3 at 100, +5 at 200, +10 at 365",
      },
      { key: "maxStatLevel", label: "Highest stat level that counts", unit: "levels", min: 1, max: 200 },
    ],
  },
  // PixFray dollars (server/channel.ts payDuels and give). Mods gift dollars from the Players tab.
  {
    title: "Dollars",
    fields: [
      { key: "winDollars", label: "Dollars for a win", unit: "$", min: 0, max: 100 },
      { key: "lossDollars", label: "Dollars for a loss", unit: "$", min: 0, max: 100 },
      {
        key: "giveEnabled",
        label: "Viewers can give dollars",
        bool: true,
        hint: "!give @name amount (!pay with StreamElements), only while the stream is live",
      },
      { key: "giveMaxPerStream", label: "Most one viewer gives per stream", unit: "$", min: 0, max: 10000 },
      { key: "giveMinDuels", label: "Finished duels before giving", unit: "duels", min: 0, max: 1000 },
    ],
  },
  // The PixFray bot as a whole (server/channel.ts botCommand) and its timed !fray line (postReminder). Only channels the bot reads chat for.
  {
    title: "Chat bot",
    visible: (_, a) => Boolean(a.chatBot) && liveChat(a).connected === true && liveChat(a).source !== "streamelements",
    fields: [
      {
        key: "botEnabled",
        label: "Bot answers commands",
        bool: true,
        hint: "Off: the bot ignores every command and posts nothing. The broadcaster or a mod can also type !fray off or !fray on in chat",
      },
      { key: "reminderMin", label: "!fray reminder every (0 = off)", unit: "min", min: 0, max: 240 },
    ],
  },
  // The shop (server/pets.ts): pet prices by tier, and locked hats cost this much per win they need (0 = not for sale).
  {
    title: "Shop",
    fields: [
      { key: "petPriceCommon", label: "Common pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceUncommon", label: "Uncommon pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceRare", label: "Rare pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceEpic", label: "Epic pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceLegendary", label: "Legendary pet", unit: "$", min: 1, max: 100000 },
      { key: "hatPricePerWin", label: "Hat price per win it needs", unit: "$", min: 0, max: 1000 },
      { key: "recolorPrice", label: "Character recolor", unit: "$", min: 1, max: 100000 },
      { key: "petColorPrice", label: "Pet color", unit: "$", min: 1, max: 100000 },
      { key: "accessoryPrice", label: "Accessory", unit: "$", min: 1, max: 100000 },
      { key: "trailPrice", label: "Walking trail", unit: "$", min: 1, max: 100000 },
      { key: "effectPrice", label: "Win effect", unit: "$", min: 1, max: 100000 },
      { key: "tauntPrice", label: "Win taunt", unit: "$", min: 1, max: 100000 },
      { key: "titlePrice", label: "Title", unit: "$", min: 1, max: 100000 },
      { key: "buildSlotPrice", label: "2nd build slot", unit: "$", min: 1, max: 100000 },
      { key: "buildSlotPriceMore", label: "Each build slot after that", unit: "$", min: 1, max: 100000 },
    ],
  },
  // Only used when config.quickDuel is false, and no screen turns that off, so the group stays hidden (but in the form, so saving keeps its values).
  {
    title: "HP fight abilities",
    visible: (c) => c.quickDuel === false,
    fields: [
      { key: "abilities.strike.damage", label: "Strike damage", unit: "HP", min: 1, max: 1000 },
      { key: "abilities.strike.cooldownMs", label: "Strike cooldown", unit: "s", ms: true, min: 250, max: 600000 },
      { key: "abilities.heavy.damage", label: "Heavy strike damage", unit: "HP", min: 1, max: 1000 },
      { key: "abilities.heavy.cooldownMs", label: "Heavy strike cooldown", unit: "s", ms: true, min: 250, max: 600000 },
      { key: "abilities.heal.amount", label: "Heal amount", unit: "HP", min: 1, max: 1000 },
      { key: "abilities.heal.cooldownMs", label: "Heal cooldown", unit: "s", ms: true, min: 250, max: 600000 },
      { key: "sharedCooldownMs", label: "Delay between any two actions", unit: "s", ms: true, min: 250, max: 60000 },
    ],
  },
];
const FIELDS = GROUPS.flatMap((g) => g.fields);
const LABELS = Object.fromEntries<Label>([
  ...FIELDS.map((f): [string, Label] => [f.key, f]),
  ["enabled", { label: "Duels enabled" }],
]);
const get = (obj: unknown, key: string) =>
  // each step reads one property of an object (or of anything else, which yields undefined as before)
  key.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
const flatten = (config: Config | null | undefined) =>
  Object.fromEntries([...FIELDS.map((f) => [f.key, get(config, f.key)]), ["enabled", config?.enabled]]);
function show(key: string, v: unknown) {
  const f = LABELS[key];
  if (v === undefined) return "—";
  if (key === "enabled" || f?.bool) return v ? "on" : "off";
  // ms fields hold numbers
  if (f?.ms) return seconds(v as number);
  // a number, or text for a value the server sent as text
  return (v as number) + (f?.unit && f.unit !== "s" ? " " + f.unit : "");
}
const configStatus = $<HTMLParagraphElement>("#config-status"),
  fields = $<HTMLDivElement>("#config-fields");

// The form remembers the version it was built from. Unsaved edits survive live updates; if someone else saves in
// the meantime, the save is sent with the old baseVersion and the server answers 409 (handled below).
let editedBase = 0,
  editedConfig: Config | null = null;
export function renderConfig() {
  const a = admin(),
    config = a.config;
  if (fields.childElementCount && formDirty()) {
    if (editedBase !== a.configVersion) {
      const why = `Version ${a.configVersion} was saved by someone else while you were editing.`;
      setStatus(configStatus, why + " Discard your changes to load it.", "error");
    }
    return;
  }
  editedBase = a.configVersion;
  editedConfig = config;
  fields.replaceChildren(
    ...GROUPS.map((g) =>
      h(
        "fieldset",
        { class: "config-group", hidden: g.visible && !g.visible(config, a) },
        h("legend", {}, g.title),
        h(
          "div",
          { class: "config-grid" },
          g.fields.map((f) => {
            const id = "cfg-" + f.key.replace(/\./g, "-"),
              value = get(config, f.key);
            if (f.bool)
              return h(
                "div",
                {},
                h(
                  "label",
                  { class: "check", for: id },
                  h("input", { id, type: "checkbox", "data-key": f.key, checked: Boolean(value) }),
                  " " + f.label,
                ),
                h("p", { class: "hint" }, f.hint),
              );
            const k = f.ms ? 1000 : 1;
            return h(
              "div",
              {},
              h("label", { for: id }, f.label + " (" + f.unit + ")"),
              h("input", {
                id,
                type: "number",
                inputmode: "decimal",
                required: true,
                "data-key": f.key,
                min: f.min / k,
                max: f.max / k,
                step: f.ms ? 0.25 : 1,
                // ms fields hold numbers
                value: String(f.ms ? (value as number) / 1000 : value),
              }),
              h("p", { class: "hint" }, f.ms ? seconds(f.min) + " to " + seconds(f.max) : f.min + " to " + f.max),
            );
          }),
        ),
      ),
    ),
  );
  syncConfigButtons();
}
function readField(input: HTMLInputElement): { value?: unknown; error?: string } {
  // the inputs carry a FIELDS key in data-key (renderConfig), so the entry is a Field
  const f = LABELS[input.dataset.key!] as Field,
    raw = input.value.trim(),
    n = Number(raw);
  if (f.bool) return { value: input.checked };
  if (raw === "" || !Number.isFinite(n)) return { error: f.label + " needs a number." };
  const value = f.ms ? Math.round(n * 1000) : n;
  if (!Number.isInteger(value)) return { error: f.label + " must be a whole number." };
  if (value < f.min || value > f.max)
    return { error: f.label + " must be between " + show(f.key, f.min) + " and " + show(f.key, f.max) + "." };
  return { value };
}
function buildPatch() {
  const patch: Record<string, unknown> = {},
    errors: string[] = [];
  for (const input of fields.querySelectorAll<HTMLInputElement>("input[data-key]")) {
    // the selector asks for a data-key
    const key = input.dataset.key!,
      r = readField(input);
    input.setCustomValidity(r.error || "");
    if (r.error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    // each input sits in its field's div
    input.parentElement!.classList.toggle("changed", !r.error && r.value !== get(editedConfig, key));
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    if (r.value === get(editedConfig, key)) continue;
    const path = key.split(".");
    let node = patch;
    // each level is an object this loop made
    for (const part of path.slice(0, -1)) node = (node[part] ||= {}) as Record<string, unknown>;
    // split() returns at least one part
    node[path.at(-1)!] = r.value;
  }
  return { patch, errors };
}
const formDirty = () => Object.keys(buildPatch().patch).length > 0;
addEventListener("beforeunload", (e) => {
  if (S.admin && formDirty()) e.preventDefault();
}); // unsaved rule edits
function syncConfigButtons() {
  const { patch, errors } = buildPatch(),
    changed = Object.keys(patch).length > 0,
    version = admin().configVersion;
  const save = $<HTMLButtonElement>("#config-save");
  save.disabled = !changed || errors.length > 0;
  save.className = "btn" + (changed && !errors.length ? " btn-primary" : "");
  $<HTMLButtonElement>("#config-discard").disabled = !changed;
  const bar = $("#config-bar");
  bar.classList.toggle("dirty", changed);
  if (errors.length) setStatus(configStatus, errors[0], "error");
  else if (editedBase === version)
    setStatus(configStatus, changed ? "Unsaved changes. Saving creates version " + (version + 1) + "." : "");
  // The bar appears with the first edit; if it lands on the field being typed in, scroll that field above it.
  const field = document.activeElement;
  if (changed && field && fields.contains(field)) {
    const overlap = field.getBoundingClientRect().bottom + 12 - bar.getBoundingClientRect().top;
    if (overlap > 0) scrollBy(0, overlap);
  }
}
on<HTMLFormElement>("#config-form", syncConfigButtons, "input");
on("#config-discard", () => {
  fields.replaceChildren();
  renderConfig();
});
const mergeConfig = (base: Config, patch: Partial<Config>) => ({
  ...base,
  ...patch,
  abilities: Object.fromEntries(
    Object.entries(base.abilities || {}).map(([k, v]) => [k, { ...v, ...patch.abilities?.[k] }]),
  ),
});
onSubmit("#config-form", async () => {
  const { patch, errors } = buildPatch();
  if (errors.length || !Object.keys(patch).length) return;
  const save = $<HTMLButtonElement>("#config-save");
  save.disabled = true;
  setStatus(configStatus, "Saving…");
  const note = $<HTMLInputElement>("#config-note");
  const r = await post({ action: "config", payload: { patch, baseVersion: editedBase, note: note.value.trim() } });
  if (r.status === 409) {
    // editedConfig!: the form was built from it; buildPatch nests dotted keys, so patch has Config's shape
    const mine = diff(editedConfig, mergeConfig(editedConfig!, patch as Partial<Config>));
    fields.replaceChildren();
    await load();
    const now = `Not saved: someone else saved version ${admin().configVersion} first.`;
    setStatus(configStatus, `${now} The form now shows the current values. Your change was: ${mine}.`, "error");
    return;
  }
  if (!r.ok) {
    save.disabled = false;
    setStatus(configStatus, "Not saved: " + errorText(r), "error");
    return;
  }
  note.value = "";
  fields.replaceChildren();
  await load();
  setStatus(configStatus, "Saved as version " + admin().configVersion + ".", "ok");
});
function diff(prev: Config | null | undefined, next: Config) {
  if (!prev) return "Starting values";
  const a = flatten(prev),
    b = flatten(next);
  const changes = Object.keys(b)
    .filter((k) => a[k] !== b[k])
    .map((k) => (LABELS[k]?.label || k) + " " + show(k, a[k]) + " → " + show(k, b[k]));
  return changes.length ? changes.join("; ") : "No value changes";
}
export function renderHistory() {
  const a = admin(),
    rows = a.history || [];
  $("#history-title").textContent = `Version history (${rows.length} version${rows.length === 1 ? "" : "s"})`;
  const list = rows.map((v, i) =>
    row(
      [
        "v" + v.version,
        dateTime(v.at),
        nameOf(v.actorId),
        diff(rows[i + 1]?.config, v.config),
        v.note || "",
        v.version === a.configVersion
          ? h("span", { class: "badge positive" }, "Current")
          : button("Revert to v" + v.version, (b) =>
              act(
                "rollbackConfig",
                { version: v.version },
                { button: b, done: `Restored v${v.version} as a new version.` },
              ),
            ),
      ],
      [0],
    ),
  );
  fillTable("history", list, 6, "No saved versions yet. The first save is recorded here.");
}
