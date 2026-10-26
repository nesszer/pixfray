// The Save bar and its status line, sign-in state, drafts kept across the Twitch round trip, other-channel fighters.
import { api, errorText, h, $, setStatus, renderWho, signOut, button, CHANNEL } from "../ui.ts";
import { acceptedUnreadable, parseAnswer, parseDraft, parseProfileSaved } from "../parse.ts";
import { warnOnce } from "../served/parse.ts";
import {
  state,
  form,
  saveBtn,
  status,
  REASONS,
  loadoutOf,
  copy,
  same,
  current,
  activeBuild,
  savedSlot,
  dirty,
  edited,
  pickable,
  canShop,
  signedIn,
  money,
  lockedWorn,
  wornList,
} from "./state.ts";
import type { Loadout, Other } from "./state.ts";
import { renderCharacters } from "./fighter.ts";
import { loadLeaderboard } from "./ranks.ts";
import { renderAll, applyProfile } from "../dashboard.ts";

const saveSignin = $<HTMLAnchorElement>("#save-signin");
export function renderSave() {
  saveBtn.disabled = Boolean(state.off);
  const locked = lockedWorn();
  if (signedIn() && state.off === "paused") {
    setStatus(
      status,
      state.profile
        ? "PixFray is off on this channel right now, so saving and buying are closed. Your fighter is kept."
        : "PixFray is off on this channel right now. You can save a fighter when it's back.",
    );
  } else if (signedIn() && state.profile) {
    const msg = locked.length
      ? "Trying on " + wornList(locked) + ". Buy " + (locked.length === 1 ? "it" : "them") + " to save this look."
      : state.slot !== activeBuild()
        ? "Build " + (state.slot + 1) + " isn't on stream. Save to switch to it."
        : dirty()
          ? "You have unsaved changes."
          : fresh()
            ? ""
            : "Saved. Your fighter shows up on stream with these settings.";
    setStatus(status, msg, locked.length || dirty() ? "" : "ok");
  } else if (signedIn()) {
    setStatus(
      status,
      locked.length
        ? "Trying on " + wornList(locked) + ". Save a fighter first, then buy it."
        : state.others.length
          ? "You don't have a fighter on " + CHANNEL + "'s channel yet. Fighters are saved per channel."
          : "You don't have a saved profile yet. Pick your fighter and save.",
    );
  } else if (knownViewer() && !status.textContent && !state.loading) {
    setStatus(
      status,
      "You're signed out, so this is a starting fighter, not yours. Sign in to load the one you saved.",
    );
  }
  renderOthers();
  saveBtn.textContent = state.slot !== activeBuild() ? "Save and wear build " + (state.slot + 1) : "Save profile";
  // Until the first duel: what to type in chat now that the fighter is saved.
  const next = $("#next-step"),
    show = Boolean(signedIn() && state.profile && !state.off && !dirty() && !locked.length && fresh());
  next.hidden = !show;
  if (show)
    next.replaceChildren(
      h("strong", {}, "Saved. Next: "),
      "in " + CHANNEL + "'s chat, type ",
      h("code", {}, "!challenge @friend"),
      ". They answer ",
      h("code", {}, "!fight"),
      ".",
    );
}

// profile!: Boolean(state.profile) first (TypeScript doesn't narrow through Boolean())
const fresh = () => Boolean(state.profile) && !(state.profile!.wins + state.profile!.losses);

// Back from Twitch sign-in (?signed_in=1): say who is signed in and what to do, then drop the flag from the address.
export function welcome() {
  const params = new URLSearchParams(location.search),
    user = state.session?.user;
  if (!params.has("signed_in")) return;
  params.delete("signed_in");
  history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
  if (!user) return;
  const next = state.profile ? "Your fighter is loaded." : "Pick a fighter and save.";
  setStatus(status, `Signed in as ${user.displayName || user.login}. ${next}`, "ok");
  if (!state.profile) $("#fighter").scrollIntoView({ block: "start" });
}

// This browser signed in before: signed out, the page says the preview isn't their fighter (sign-in lasts 30 days).
export const KNOWN_KEY = "pixfray:signed-in";
function knownViewer() {
  try {
    return localStorage.getItem(KNOWN_KEY) === "1";
  } catch {
    return false;
  }
}
// Edits made before signing in (signed out, or after the session ran out) come back after the Twitch round trip.
const DRAFT_KEY = "pixfray:draft:" + CHANNEL,
  DRAFT_MS = 30 * 60_000;
// b!: same() is false for a null b
const sameLook = (a: Loadout, b: Loadout | null) => same(a, b) && a.defaultAbility === b!.defaultAbility;
function stashDraft() {
  if (!state.d || state.loading) return;
  const base = state.profile ? savedSlot() : loadoutOf(null);
  if (sameLook(state.d, base) && state.slot === activeBuild()) return;
  try {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ d: current(), withProfile: Boolean(state.profile), at: Date.now() }),
    );
  } catch {}
}
export function restoreDraft() {
  // A draft this page stored (stashDraft); the checks below still treat each field as untrusted.
  let text = null;
  try {
    text = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
  const draft = parseDraft(text);
  if (!draft.ok) warnOnce("the stored draft", draft.error);
  const saved = draft.value;
  if (!signedIn() || !saved || !(Date.now() - saved.at < DRAFT_MS)) return false;
  const d = loadoutOf(saved.d);
  // Upgrade points come from the saved fighter, unless the draft was made on it (an expired session).
  if (!(saved.withProfile && state.profile)) d.stats = copy(state.d).stats;
  else if (Number.isInteger(saved.d.build) && saved.d.build >= 0 && saved.d.build < Math.max(1, state.builds.length))
    state.slot = saved.d.build;
  if (sameLook(d, state.d) && state.slot === activeBuild()) return false;
  state.d = d;
  renderAll();
  const how = state.profile ? "Save to keep them, or reload the page to see your saved fighter." : "Save to keep them.";
  setStatus(status, "Your changes from before you signed in are back, not saved yet. " + how);
  return true;
}
// Every "Sign in" link (the Save button's and the header's) carries data-login.
document.addEventListener("click", (e) => {
  if ((e.target as Element).closest?.("[data-login]")) stashDraft(); // as Element: a click's target is an element
});
// Fighters are saved per channel: on a channel where the viewer has none, offer the base look they use on another.
export async function loadOthers() {
  if (!signedIn() || state.profile || state.off) return;
  const r = await api("/api/profile/" + CHANNEL + "/others");
  const pick = new Set(pickable().map((e) => e.id));
  state.others =
    r.ok && Array.isArray(r.data?.fighters)
      ? r.data.fighters.filter((f: Other) => pick.has(f.avatar) && f.channel !== CHANNEL).slice(0, 3)
      : [];
  if (state.others.length) renderSave();
}
function renderOthers() {
  const box = $<HTMLDivElement>("#others"),
    list = signedIn() && !state.profile && !state.off ? state.others : [];
  box.hidden = !list.length;
  if (!list.length) return box.replaceChildren();
  box.replaceChildren(
    h(
      "p",
      { class: "small" },
      "Start from the fighter you use on another channel. Gear and upgrades stay on their own channel.",
    ),
    h(
      "div",
      { class: "others-actions" },
      ...list.map((f) => button("Use my " + f.channel + " fighter", () => useOther(f))),
    ),
  );
}
function useOther(f: Other) {
  Object.assign(state.d, {
    avatar: f.avatar,
    color: /^#[0-9a-f]{6}$/i.test(f.color || "") ? f.color.toLowerCase() : state.d.color,
    defaultAbility: ["strike", "heavy", "heal"].includes(f.defaultAbility) ? f.defaultAbility : state.d.defaultAbility,
  });
  renderCharacters();
  renderAll();
  setStatus(status, "Copied your " + f.channel + " fighter. Save to keep it on " + CHANNEL + "'s channel.");
}

const signinNotes = {
  none: "Sign-in is unavailable right now, so profiles can't be saved. You can still browse characters and the leaderboard.",
  off: "Twitch sign-in isn't set up on this server yet, so profiles can't be saved. You can still browse characters and the leaderboard.",
  on: "Sign in with Twitch to save your fighter. It shares only your public Twitch name, and ranked duels need a saved profile.",
};
export function renderSignedIn() {
  const s = state.session,
    p = state.profile,
    note = $("#signin-note");
  renderWho($<HTMLDivElement>("#who"), s, signOut);
  saveBtn.hidden = !signedIn();
  saveSignin.hidden = signedIn() || s?.configured === false;
  saveSignin.textContent = knownViewer() || p ? "Sign in to load your fighter" : "Sign in with Twitch to save";
  // one sign-in button: the preview card's, next to what it saves
  if (!saveSignin.hidden) $("#who").replaceChildren();
  note.hidden = signedIn() || Boolean(s?.configured); // the usual signed-out case: the card's hint says what sign-in shares
  $("#signin-hint").hidden = saveSignin.hidden;
  note.textContent = signinNotes[!s ? "none" : s.configured === false ? "off" : "on"];
  $("#my-stats").hidden = !p;
  if (p) {
    $("#stat-elo").textContent = String(p.elo);
    $("#stat-wl").textContent = p.wins + " / " + p.losses;
    $("#stat-dollars").textContent = money(p.dollars);
    // shown only once channel point rewards added some
    $("#stat-style-box").hidden = !p.styleDollars;
    $("#stat-style").textContent = money(p.styleDollars);
    $("#stat-streak").textContent = String(p.streak || 0);
  }
  $("#shop-note").textContent =
    (canShop() ? "You have " + money(p!.dollars) + ". " : "") + // p!: canShop() needs a profile
    (canShop() && p!.styleDollars // as above
      ? "Your " + money(p!.styleDollars) + " in style dollars from channel points goes first. " // as above
      : "") +
    "Spend the PixFray dollars you earn in duels. Everything here changes looks only, not stats, and you can wear it in any build." +
    (signedIn() ? "" : " Try anything on now; sign in to buy.");
}
// A 401 means the session ran out: show the page signed out.
export function expired() {
  state.session = { ...state.session, user: null };
  renderSignedIn();
}

addEventListener("beforeunload", (e) => {
  if (signedIn() && edited()) e.preventDefault();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!signedIn()) return;
  const body = current();
  if (!body.avatar) return setStatus(status, "Pick a character first.", "error");
  const locked = lockedWorn();
  if (locked.length)
    return setStatus(status, "Not saved: buy " + wornList(locked) + " first, or pick something you own.", "error");
  saveBtn.disabled = true;
  setStatus(status, "Saving…");
  const r = parseAnswer(
    await api("/api/profile/" + CHANNEL, { method: "POST", body }),
    parseProfileSaved,
    "the saved profile",
  );
  saveBtn.disabled = false;
  if (r.status === 401) {
    expired();
    return setStatus(
      status,
      "Your session expired. Sign in again to save. Your changes come back after you sign in.",
      "error",
    );
  }
  if (acceptedUnreadable(r))
    return setStatus(
      status,
      "Your profile may have saved, but this page couldn't read the answer. Reload the page to check.",
      "error",
    );
  if (!r.ok) return setStatus(status, "Not saved: " + (REASONS[r.data?.error] || errorText(r)), "error");
  const drafts = state.drafts.map((d, i) => (i === body.build ? null : d));
  state.profile = { owned: state.owned, ...r.data.profile };
  applyProfile(state.profile);
  state.drafts = drafts; // unsaved edits in the other builds stay
  renderAll();
  loadLeaderboard();
});

// The channel is turned off (paused) or was never set up (server/channels.ts).
export function showOff(off: string) {
  const note = $("#off-note");
  note.hidden = false;
  if (off === "paused") {
    note.textContent =
      "PixFray is off on " + CHANNEL + "'s channel right now. Saved fighters and ranks are kept for when it's back.";
    return;
  }
  note.replaceChildren(
    "PixFray isn't set up on " +
      CHANNEL +
      "'s channel yet. Fights happen in their chat, so " +
      CHANNEL +
      " turns it on first, on ",
    h("a", { href: "/start/" }, "/start"),
    ". Until then, ",
    h("a", { href: "/play/" }, "pick another channel"),
    ".",
  );
  for (const el of [form, $(".fighter-card"), $(".hero-pick .tabs")]) el.hidden = true;
  $("#panel-ranks").hidden = false;
}

// Phones: the fixed Save bar stays put while you pick; it steps aside on Ranks and Rules unless there is something
// to save or say, and at the footer so the page's last links aren't under it.
export function tuckSaveBar() {
  const root = document.documentElement,
    quiet = !status.textContent && !dirty(),
    foot = $<HTMLElement | null>(".site-foot"),
    atFoot = !!foot && foot.getBoundingClientRect().top < innerHeight;
  root.classList.toggle(
    "bar-away",
    (quiet && (root.dataset.tab === "ranks" || root.dataset.tab === "rules")) || atFoot,
  );
  root.classList.toggle("at-top", quiet && scrollY < 40);
}
export function watchSaveBar() {
  addEventListener("scroll", tuckSaveBar, { passive: true });
  new MutationObserver(tuckSaveBar).observe(status, { childList: true, characterData: true, subtree: true });
  form.addEventListener("change", tuckSaveBar);
  tuckSaveBar();
}
