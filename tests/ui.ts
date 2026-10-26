// Lane B UI test: viewer dashboard ("/") and mod controls ("/admin/") at 1280px and 390px.
// Signed-out runs against the real local server (`bunx cf dev` / vite); signed-in states stub /api/* with page.route.
// Usage: MINI_BASE_URL=http://127.0.0.1:5193 node tests/ui.ts
import { launchChrome } from "./chrome.ts";
import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import assert from "node:assert/strict";
import { enforceCsp } from "./csp-helper.ts";
import { makePng } from "./upload-helpers.ts";
import type { Loose } from "./fakes.ts";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const base = process.env.MINI_BASE_URL || "http://127.0.0.1:5173";
const shots = fileURLToPath(new URL("../screenshots", import.meta.url));
fs.mkdirSync(shots, { recursive: true });
const browser = await launchChrome();
const errors: string[] = [];
// The init script's WebSocket stub keeps each socket the page opens on window.__sockets (not in lib.dom).
type StubWindow = { __sockets: { url: string }[] };
type Size = { name: string; width: number; height: number };
const sizes: [Size, Size] = [
  { name: "1280", width: 1280, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const now = Date.now();
const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
const user = { id: "1001", login: "viewer_one", displayName: "Viewer_One" };
const mod = { id: "2002", login: "mod_two", displayName: "Mod_Two" };
const config = {
  enabled: true,
  maxHp: 100,
  maxDuels: 5,
  challengeTimeoutMs: 30000,
  inactivityMs: 45000,
  respawnMs: 3000,
  rematchDelayMs: 30000,
  streamDelayMs: 6000,
  sharedCooldownMs: 1000,
  initialElo: 1000,
  eloK: 24,
  pairRankedPerStream: 0,
  checkinPoints: 1,
  streakBonus: true,
  maxStatLevel: 16,
  winDollars: 5,
  lossDollars: 3,
  giveEnabled: true,
  giveMaxPerStream: 100,
  giveMinDuels: 5,
  reminderMin: 0,
  botEnabled: true,
  petPriceCommon: 30,
  petPriceUncommon: 75,
  petPriceRare: 180,
  petPriceEpic: 420,
  petPriceLegendary: 900,
  hatPricePerWin: 10,
  recolorPrice: 60,
  petColorPrice: 40,
  accessoryPrice: 80,
  trailPrice: 120,
  effectPrice: 150,
  tauntPrice: 25,
  titlePrice: 50,
  buildSlotPrice: 200,
  buildSlotPriceMore: 400,
  abilities: {
    strike: { damage: 20, cooldownMs: 2000 },
    heavy: { damage: 35, cooldownMs: 5000 },
    heal: { amount: 15, cooldownMs: 12000 },
  },
};
const board = [
  {
    userId: "3003",
    username: "top_dog",
    displayName: "top_dog",
    avatar: "soldier",
    color: "#34d399",
    defaultAbility: "heavy",
    elo: 1048,
    wins: 4,
    losses: 1,
  },
  {
    userId: "1001",
    username: "viewer_one",
    displayName: "Viewer_One",
    avatar: "zombie",
    color: "#f472b6",
    defaultAbility: "heal",
    elo: 1012,
    wins: 2,
    losses: 1,
  },
  {
    userId: "4004",
    username: "newbie",
    displayName: "newbie",
    avatar: "female",
    color: "#60a5fa",
    defaultAbility: "strike",
    elo: 976,
    wins: 0,
    losses: 2,
  },
];
async function noOverflow(page: Page, label: string) {
  const { sw, cw, wide } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll("body *")]
      .filter(
        (e) =>
          e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 &&
          // every element under body has a parent
          !e.parentElement!.closest(".table-wrap"),
      )
      .slice(0, 5)
      .map(
        (e) =>
          e.tagName.toLowerCase() +
          (e.id ? "#" + e.id : "") +
          (e.className ? "." + String(e.className).replace(/ /g, ".") : ""),
      ),
  }));
  assert.ok(sw <= cw + 1, label + ": horizontal overflow " + sw + " > " + cw + " from " + wide.join(", "));
}
async function newPage(viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  await enforceCsp(context);
  await context.addInitScript(() => {
    // no real live socket in stubbed runs
    // __sockets is the stub's own list (StubWindow); the class stands in for WebSocket with url, send and close only
    (window as unknown as StubWindow).__sockets = [];
    window.WebSocket = class {
      declare url: string;
      constructor(u: string) {
        this.url = u;
        (window as unknown as StubWindow).__sockets.push(this); // StubWindow: as above
      }
      send() {}
      close() {}
    } as unknown as typeof WebSocket; // as above: a stub, not a full WebSocket
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return { context, page };
}
async function withPage(
  size: { width: number; height: number },
  fn: (page: Page, context: BrowserContext) => Promise<void>,
) {
  const { context, page } = await newPage(size);
  await fn(page, context);
  await context.close();
}
type Where = Page | Locator;
async function text(w: Where, sel: string) {
  const t = await w.locator(sel).textContent();
  assert.ok(t !== null, sel + " is on the page");
  return t;
}
async function hidden(w: Where, sel: string, message?: string) {
  assert.equal(await w.locator(sel).isHidden(), true, message ?? sel + " hidden");
}
// One check on w.locator(sel) each; leaving out the message keeps assert's own.
const textIs = async (w: Where, sel: string, want: string, msg?: string) => assert.equal(await text(w, sel), want, msg);
const textHas = async (w: Where, sel: string, re: RegExp, msg?: string) => assert.match(await text(w, sel), re, msg);
const countIs = async (w: Where, sel: string, n: number, msg?: string) =>
  assert.equal(await w.locator(sel).count(), n, msg);
const visibleIs = async (w: Where, sel: string, want: boolean, msg?: string) =>
  assert.equal(await w.locator(sel).isVisible(), want, msg);
const disabledIs = async (w: Where, sel: string, want: boolean, msg?: string) =>
  assert.equal(await w.locator(sel).isDisabled(), want, msg);
const checkedIs = async (w: Where, sel: string, want: boolean, msg?: string) =>
  assert.equal(await w.locator(sel).isChecked(), want, msg);
const valueIs = async (w: Where, sel: string, want: string, msg?: string) =>
  assert.equal(await w.locator(sel).inputValue(), want, msg);
const hrefs = (w: Where, sel: string) => w.locator(sel).evaluateAll((a) => a.map((x) => x.getAttribute("href")));
// The element's parent (its .table-wrap) shows it whole, with no sideways scroll.
const fitsWrap = (w: Where, sel: string) =>
  w
    .locator(sel)
    .locator("xpath=..")
    .evaluate((n) => n.scrollWidth <= n.clientWidth + 1);
const attrIs = async (w: Where, sel: string, name: string, want: string | null, msg?: string) =>
  assert.equal(await w.locator(sel).getAttribute(name), want, msg);
// Waits until the element's text matches; the pattern travels as source and flags.
const waitText = (page: Page, sel: string, re: RegExp, options?: { timeout: number }) =>
  page.waitForFunction(
    ([s, source, flags]) => new RegExp(source, flags).test(document.querySelector(s)?.textContent ?? ""),
    [sel, re.source, re.flags] as const,
    options,
  );
async function box(page: Page, sel: string) {
  const b = await page.locator(sel).boundingBox();
  assert.ok(b, sel + " has a box");
  return b;
}
// No sideways overflow, then a screenshot: the full page, the viewport (false) or one element (a selector).
async function shot(page: Page, name: string, of: boolean | string = true) {
  await noOverflow(page, name);
  const path = shots + "/" + name + ".png";
  await (typeof of === "string" ? page.locator(of).screenshot({ path }) : page.screenshot({ path, fullPage: of }));
}
const owner = { id: "9009", login: "nesszerra", displayName: "nesszerra" },
  newstreamer = { id: "5505", login: "newstreamer", displayName: "NewStreamer" };
const viewerAccess = { owner: false, moderator: false, canManage: false },
  modAccess = { owner: false, moderator: true, canManage: true },
  broadcasterAccess = { owner: false, broadcaster: true, moderator: false, canManage: true };
const disconnected = { connected: false, status: "disconnected", subscriptionId: "", createdAt: 0 };
// A working chat connection as the snapshot's chatStatus reports it.
const chatOn = (fields: object) => ({
  connected: true,
  status: "enabled",
  subscriptionId: "sub-bot",
  createdAt: now - 86400000,
  lastNotificationAt: now - 120000,
  lastRevocationReason: "",
  checkedAt: 0,
  ...fields,
});
const seKey = "k".repeat(48);
// StreamElements setup with no command seen yet; commands holds one reply line per action, each carrying the key.
const seSetup = (fields: object = {}, actions: string[] = []) => ({
  key: seKey,
  names: {},
  origin: base,
  lastCommandAt: 0,
  rejectedAt: 0,
  seen: {},
  duelModuleOff: false,
  timerText: "x",
  commands: actions.map((action) => ({
    action,
    name: "!" + action,
    response: "$(customapi " + base + "/api/se/nesszerra/" + action + "?k=" + seKey + ")",
  })),
  ...fields,
});
const botSite = {
  chatBot: { login: "pixfray", debug: false },
  botCommands: { commands: [], counters: [], max: 50 },
  botStatus: null,
};
// who may be a function, for a session that changes during the test
const stubSession = (page: Page, who: object | null | (() => object | null), isOwner = false) =>
  page.route("**/api/session", (r) =>
    json(r, {
      user: typeof who === "function" ? who() : who,
      owner: isOwner,
      configured: true,
      channels: ["nesszerra"],
      productionEnabled: false,
    }),
  );
// viewer_one's saved fighter as /api/profile answers it
const myFighter = (fields: object) => ({
  ...board[1],
  hp: 100,
  registered: true,
  respawnAt: 0,
  lastSeen: now,
  ...fields,
});
// A signed-in viewer on nesszerra: the profile answer (or handler), and the leaderboard when one is given.
async function stubViewer(page: Page, profile: object | null | ((r: Route) => unknown), lb?: unknown[]) {
  await stubSession(page, user);
  await page.route("**/api/access/nesszerra", (r) => json(r, viewerAccess));
  if (lb) await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, lb));
  await page.route("**/api/profile/nesszerra", (r) => (typeof profile === "function" ? profile(r) : json(r, profile)));
}
type AdminStub = {
  channel?: string;
  who?: object;
  isOwner?: boolean;
  access?: object;
  lb?: unknown[];
  snapshot?: () => Loose; // Loose: snapshot fields, spread over the defaults
  post?: (body: Loose, r: Route) => unknown; // Loose: a POST body, read by field
};
// A signed-in mod page: session, access, leaderboard, no custom characters, and /api/admin answering GET with a
// snapshot (chat follows its chatStatus) and POST with the handler's answer, or ok. Returns the POST bodies.
async function stubAdmin(page: Page, o: AdminStub = {}) {
  const ch = o.channel ?? "nesszerra",
    access = o.access ?? modAccess,
    posts: Loose[] = []; // Loose: the POST bodies, read by field in the tests
  await stubSession(page, o.who ?? mod, o.isOwner);
  await page.route("**/api/access/" + ch, (r) => json(r, access));
  await page.route("**/api/leaderboard/" + ch + "*", (r) => json(r, o.lb ?? []));
  await page.route("**/api/assets/" + ch, (r) =>
    json(r, {
      items: [],
      usage: { count: 0, limit: 8, bytes: 0 },
      limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
    }),
  );
  await page.route("**/api/admin/" + ch, (r) => {
    if (r.request().method() === "POST") {
      const body = r.request().postDataJSON();
      posts.push(body);
      return o.post?.(body, r) ?? json(r, { ok: true });
    }
    const snap = {
      type: "snapshot",
      channel: ch,
      revision: 1,
      paused: false,
      config,
      configVersion: 1,
      round: 1,
      players: [],
      duels: [],
      events: [],
      chatStatus: disconnected,
      history: [{ version: 1, config, actorId: "system", at: now - 86400000, note: "" }],
      customUsage: { count: 0, limit: 8, bytes: 0 },
      access,
      ...o.snapshot?.(),
    };
    const c = snap.chatStatus;
    return json(r, {
      ...snap,
      chat: { connected: c.connected, lastSeen: c.lastNotificationAt ?? 0, status: c.status },
    });
  });
  return posts;
}
try {
  // 1. Signed out, real server (no Twitch credentials locally).
  for (const s of sizes)
    await withPage(s, async (page) => {
      await page.goto(base + "/?channel=nesszerra");
      assert.match(await page.title(), /PixFray/);
      await page.waitForSelector("#characters input[name=character]");
      const count = await page.locator("#characters input[name=character]").count();
      assert.ok(count >= 5, "expected at least 5 characters, got " + count);
      await hidden(page, "#save");
      await page.waitForFunction(() => !document.querySelector("#leaderboard tbody")!.textContent.includes("Loading")); // the page has this element
      await page.waitForFunction(() => {
        const c = document.querySelector<HTMLCanvasElement>("#preview")!; // the page has this canvas
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; // a 2d canvas, so the context exists
        for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
        return false;
      });
      // Loose: the session body, read by field below
      const session = await page.evaluate(() => fetch("/api/session").then((r) => r.json<Loose>()));
      if (session.configured === false) await textHas(page, "#signin-note", /isn't set up/);
      else await visibleIs(page, "#save-signin", true);
      await countIs(page, '#who a[href^="/auth/login"]', 0, "one sign-in button: the fighter card has it");
      await countIs(page, "#obs-setup", 0, "the OBS link lives in mod controls, not on the viewer page");
      if (await page.locator("#leaderboard tr.empty").count())
        await textHas(
          page,
          "#leaderboard tr.empty",
          /To get on the board: sign in and save your fighter.*!challenge @viewer/,
        );
      await page.locator("#char-soldier").check({ force: true });
      await textHas(page, "#preview-caption", /Soldier/);
      // Character search and type filters.
      await page.fill("#char-search", "zomb");
      await countIs(page, "#characters .char-option:visible", 1, "search finds the zombie");
      await page.fill("#char-search", "");
      await page.locator("#char-groups [data-group=robots]").click();
      const robots = await page
        .locator("#characters .char-option:visible label > span:not(.thumb):not(.tag)")
        .allTextContents();
      assert.ok(
        robots.length >= 3 && robots.some((t) => /robot/i.test(t)) && !robots.some((t) => /zombie/i.test(t)),
        "Robots & aliens filter: " + robots.join(", "),
      );
      await hidden(page, "#more-chars", "no Show all while filtered");
      await page.locator("#char-groups [data-group=all]").click();
      // Tabs: the rules link opens Rules; the hash picks the tab on load.
      await hidden(page, "#panel-shop");
      await page.locator('.hero-copy a[href="#duels"]').click();
      await attrIs(page, "#tab-rules", "aria-selected", "true");
      await visibleIs(page, "#duels", true);
      assert.equal(new URL(page.url()).hash, "#duels");
      await page.locator("#tab-shop").click();
      await visibleIs(page, "#panel-shop", true);
      await hidden(page, "#panel-ranks");
      await page.keyboard.press("ArrowRight");
      await attrIs(page, "#tab-pets", "aria-selected", "true", "arrow keys move between tabs");
      assert.equal(new URL(page.url()).hash, "#pets");
      // Shop tiles and try-on while signed out: the preview wears it; buying needs a sign-in.
      await page.locator("#tab-shop").click();
      await page.locator('.jump a[href="#shop-trail"]').click();
      await page.waitForSelector("#trail-flames", { state: "attached" });
      await page.locator("label[for=trail-flames]").click();
      await textHas(page, "#status-trail", /Trying on Flames in the preview\. Sign in to buy it\./);
      await disabledIs(page, "#play-win", true, "no win effect or taunt yet");
      await page.locator('.jump a[href="#win-effects"]').click();
      await page.locator("label[for=effect-confetti]").click();
      await disabledIs(page, "#play-win", false);
      assert.match((await page.locator("#preview").getAttribute("aria-label"))!, /Flames trail/); // the page sets this attribute
      await page.locator("#tab-fighter").click();
      await shot(page, "viewer-signed-out-real-" + s.name);
      await page.goto(base + "/admin/");
      await page.waitForFunction(() => !document.querySelector("#gate-text")!.textContent.includes("Checking")); // the page has this element
      await hidden(page, "#app");
      await textHas(page, "#gate-text", /Sign in|isn't set up/);
      await shot(page, "admin-signed-out-real-" + s.name);
    });

  // 1a. /changelog/ reads at both widths; the release index sits beside the notes on wide screens only.
  for (const s of sizes)
    await withPage(s, async (page) => {
      await page.goto(base + "/changelog/");
      await textIs(page, "h1:visible", "What's new in PixFray");
      await countIs(page, ".btn-primary:visible", 0, "the header's Pick your fighter stays the only gold");
      assert.ok((await page.locator("section.release").count()) > 0);
      await visibleIs(page, ".changelog .page-index", s.width > 900, "index only beside the notes");
      await shot(page, "changelog-" + s.name);
    });

  // 1b. /play/ asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
  for (const s of sizes)
    await withPage(s, async (page, context) => {
      await page.goto(base + "/play/");
      await page.waitForSelector("#channel-list a");
      await textIs(page, "h1:visible", "Which stream are you watching?");
      await attrIs(page, ".topbar .nav-cta", "href", "/play/", "the picker is the current page, not a channel");
      const links = await hrefs(page, "#channel-list a");
      assert.deepEqual(links.slice(0, 2), ["/?channel=nesszerra", "/?channel=miolafff"], "built-in channels first");
      await hidden(page, "#fighter", "no fighter form until a channel is picked");
      await visibleIs(page, "#save-signin", false);
      await shot(page, "viewer-picker-" + s.name);
      // the search only finds channels with PixFray on; any other name gets this site's /start/ link to send its streamer
      await page.fill("#channel-q", "some_streamer");
      await countIs(page, "#channel-list li:visible", 0, "rows filter as you type");
      const host = new URL(base).host;
      assert.ok(
        (await text(page, "#channel-status")).startsWith(
          `some_streamer isn't on ${host} yet. Send them this link to set it up: ${host}/start`,
        ),
      );
      await attrIs(page, "#channel-status a", "href", "/start/");
      await textHas(page, "#channel-status .invite-note", /run their own copy of PixFray have it on their own site/);
      await countIs(page, 'a[href*="some_streamer"]', 0, "no link to a channel without PixFray");
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      await page.click('#channel-status button:has-text("Copy invite link")');
      await waitText(page, "#channel-status button", /^Copied$/);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base + "/start/");
      await page.fill("#channel-q", "some streamer!");
      await textIs(page, "#channel-status", "No channel with PixFray matches that name.");
      await page.fill("#channel-q", "some_streamer");
      await shot(page, "viewer-picker-search-" + s.name);
      await page.fill("#channel-q", "https://www.twitch.tv/miolafff");
      await countIs(page, "#channel-list li:visible", 1, "a pasted Twitch link finds the channel");
      await page.fill("#channel-q", "");
      assert.ok((await page.locator("#channel-list li:visible").count()) >= 2);
      await page.locator("#channel-list a", { hasText: "miolafff" }).click();
      await page.waitForSelector("#characters input[name=character]");
      await textHas(page, "#hero-title", /miolafff/);
      await attrIs(page, ".topbar .nav-cta", "href", "/?channel=miolafff", '"Pick your fighter" keeps the channel');
      await attrIs(page, ".brand", "href", "/", "the brand goes home (the intro)");
      // the home page is the intro, and it offers the way back to the channel picked last
      await page.goto(base + "/");
      assert.equal(await page.locator("h1").first().textContent(), "Your Twitch chat, in the ring.");
      await page.waitForFunction(
        () => document.querySelector("#hero-actions .btn")?.textContent === "Back to miolafff",
      );
      await attrIs(page, "#hero-actions .btn", "href", "/?channel=miolafff");
      await textIs(page, '#hero-actions a[href="/play/"]', "Pick another channel");
    });
  // 1c. With many channels signed up, eight rows show and the rest are a search away.
  await withPage(sizes[0], async (page) => {
    const many = ["nesszerra", "miolafff", ...Array.from({ length: 10 }, (_, i) => "streamer_" + i)];
    await page.route("**/api/picker", async (r) => {
      const real = await (await r.fetch()).json();
      return json(r, {
        ...real,
        channels: many.map(
          (login) => real.channels.find((c: { login: string }) => c.login === login) || { login, top: [] },
        ),
      });
    });
    await page.goto(base + "/play/");
    await page.waitForSelector("#channel-list a");
    await countIs(page, "#channel-list li:visible", 8);
    await textHas(page, "#channel-status", /find the other 4 channels/);
    await page.fill("#channel-q", "streamer_9");
    assert.deepEqual(await hrefs(page, "#channel-list li:visible a"), ["/?channel=streamer_9"]);
    await textIs(page, "#channel-status", "");
    await page.press("#channel-q", "Enter");
    await page.waitForURL(/channel=streamer_9/);
  });
  // 1d. A full site doesn't invite: the search points at running your own copy.
  for (const s of sizes)
    await withPage(s, async (page) => {
      await page.route("**/api/picker", async (r) => json(r, { ...(await (await r.fetch()).json()), full: true }));
      await page.goto(base + "/play/");
      await page.waitForSelector("#channel-list a");
      await page.fill("#channel-q", "some_streamer");
      await textHas(
        page,
        "#channel-status",
        /isn't on .* yet\. This site is full right now; they can run their own copy\./,
      );
      await attrIs(page, "#channel-status a", "href", "/start/#source");
      await countIs(page, "#channel-status button", 0, "no invite link to a full site");
      await shot(page, "viewer-picker-full-" + s.name, ".landing-inner");
    });

  // 2. Signed out with Twitch configured (stubbed session): sign-in buttons show.
  await withPage(sizes[0], async (page) => {
    await stubSession(page, null);
    await page.goto(base + "/?channel=nesszerra");
    await page.waitForSelector("#save-signin:visible");
    await countIs(page, '#who a[href^="/auth/login"]', 0, "no second sign-in button in the top bar");
    await page.screenshot({ path: shots + "/viewer-signed-out-configured-1280.png", fullPage: false });
  });

  // 2b. Character resets: a browser that signed in before is told the signed-out fighter isn't theirs, edits made
  // before signing in come back after it, and a viewer with no fighter here is offered the one from another channel.
  await withPage(sizes[1], async (page) => {
    let signedIn = false;
    await stubSession(page, () => (signedIn ? user : null));
    await page.route("**/api/access/nesszerra", (r) => json(r, viewerAccess));
    await page.route("**/api/profile/nesszerra", (r) => json(r, null));
    await page.route("**/api/profile/nesszerra/others", (r) =>
      json(r, {
        fighters: [
          { channel: "miolafff", avatar: "player", color: "#aabbcc", defaultAbility: "heal", lastSeen: 5 },
          { channel: "gone", avatar: "no-such-character", color: "#000000", defaultAbility: "strike", lastSeen: 1 },
        ],
      }),
    );
    await page.route("**/auth/login*", (r) => {
      signedIn = true;
      return r.fulfill({ status: 302, headers: { location: base + "/?channel=nesszerra&signed_in=1" } });
    });
    await page.goto(base + "/?channel=nesszerra");
    await page.waitForSelector("#save-signin:visible");
    await textIs(page, "#save-signin", "Sign in with Twitch to save", "a first visit gets the plain sign-in");
    await textIs(page, "#save-status", "");
    await page.evaluate(() => localStorage.setItem("pixfray:signed-in", "1"));
    await page.reload();
    await waitText(page, "#save-status", /signed out/);
    await textIs(page, "#save-signin", "Sign in to load your fighter");
    await page.locator("#char-soldier").check({ force: true });
    await page.locator("#save-signin").click();
    await waitText(page, "#save-status", /from before you signed in are back/);
    await checkedIs(page, "#char-soldier", true, "the pick made while signed out came back");
    await hidden(page, "#others", "a restored draft is not replaced by an offer");
    await page.screenshot({ path: shots + "/viewer-draft-restored-390.png", fullPage: false });
    // A plain visit with no fighter here: one offer per usable fighter elsewhere.
    await page.reload();
    await page.waitForSelector("#others:not([hidden]) button");
    assert.deepEqual(
      await page.locator("#others button").allTextContents(),
      ["Use my miolafff fighter"],
      "unknown characters are not offered",
    );
    await page.locator("#others button").click();
    await checkedIs(page, "#char-player", true);
    await textHas(page, "#save-status", /Copied your miolafff fighter/);
    await shot(page, "viewer-others-offer-390", false);
  });

  // 3. Signed-in viewer (stubbed session/profile/leaderboard; catalog and state are real).
  for (const s of sizes)
    await withPage(s, async (page) => {
      let posted = null,
        bought = null,
        repriced = false;
      // The first confirmed buy meets a price a mod just changed (Mouse $10 -> $11); the page reloads the shop list.
      await page.route("**/api/shop/nesszerra", async (r) => {
        if (r.request().method() === "GET") {
          if (!repriced) return r.continue();
          const res = await r.fetch(),
            list = await res.json();
          list.pets = list.pets.map((p: { id: string }) => (p.id === "mouse" ? { ...p, price: 11 } : p));
          return r.fulfill({ response: res, json: list });
        }
        bought = r.request().postDataJSON();
        if (!repriced) {
          repriced = true;
          return json(r, { error: "price_changed", reason: "price_changed", price: 11 }, 409);
        }
        return json(r, {
          ok: true,
          reason: "bought",
          kind: "pet",
          id: bought.id,
          price: 11,
          dollars: 1,
          owned: { pets: [bought.id], hats: [], slots: 1 },
        });
      });
      await stubViewer(
        page,
        (r) => {
          if (r.request().method() !== "POST")
            return json(r, myFighter({ bonus: 1, checkins: 4, streak: 3, dollars: 12 }));
          posted = r.request().postDataJSON();
          return json(r, {
            profile: { ...board[1], bonus: 1, checkins: 4, streak: 3, dollars: 12, ...posted },
            revision: 9,
          });
        },
        board,
      );
      await page.goto(base + "/?channel=nesszerra");
      await page.waitForSelector("#save:not([hidden])");
      await checkedIs(page, "#char-zombie", true);
      await valueIs(page, "#color", "#f472b6");
      await attrIs(page, "#swatches > :last-child", "class", "custom-color", "Custom comes after the preset colors");
      await countIs(page, "input[name=ability]", 0, "no ability picker with quick duels");
      await hidden(page, "#admin-link");
      await textHas(page, "#stat-elo", /1012/);
      assert.equal((await text(page, "#stat-streak")).trim(), "3");
      await textIs(page, "#stat-dollars", "$12");
      await textHas(page, "#cmd-give", /up to \$100 per stream, after your first 5 duels/);
      await page.waitForSelector("#leaderboard tr.me", { state: "attached" });
      await page.locator("label[for=char-adventurer]").click();
      await page.locator('.swatch[data-color="#34d399"]').click();
      // Builds: one free slot; the next costs $60.
      await textHas(page, "#build-list", /Build 1\s*On stream/);
      assert.equal(
        await page.getByRole("button", { name: "Buy build slot 2 for $60" }).isDisabled(),
        true,
        "$12 is not enough for a slot",
      );
      // Hats and upgrades: 2 wins + 1 check-in point = 3 points; the crown needs 20 wins.
      await textHas(page, "#points-note", /3 of 3 points/);
      await page.locator("#tab-shop").click();
      await textHas(page, "#shop-note", /^You have \$12\./);
      await attrIs(page, "#hats .char-option:has(#hat-crown)", "class", "char-option locked");
      await page.locator("label[for=hat-cap]").click();
      assert.ok((await text(page, "#upgrades-help")).includes("2 from wins and 1 from check-ins"));
      // Shop: hats past the wins can be bought; a pet buy needs a second click to confirm, then the pet is picked.
      const crown = page.getByRole("button", { name: /^Buy Crown hat for \$60, you need \$48 more$/ });
      assert.equal(await crown.isDisabled(), true, "$12 is not enough for the crown");
      assert.equal(await crown.textContent(), "Need $48 more", "an item out of reach says how far off it is");
      // Cosmetics: every price is the channel's config default; trying one on blocks Save until it's bought.
      // The shop shows one section at a time; its section links switch between them.
      await hidden(page, "#shop-accessory", "only the Hats section shows first");
      await page.locator('.jump a[href="#shop-accessory"]').click();
      await hidden(page, "#hat-picker");
      assert.equal(await page.getByRole("button", { name: "Buy Cape for $25" }).isDisabled(), true);
      await page.locator('.jump a[href="#shop-title"]').click();
      await textIs(page, ".jump a[aria-current]", "Titles");
      assert.equal(await page.getByRole("button", { name: "Buy Iron Wall title for $15" }).isDisabled(), true);
      await page.locator("label[for=title-wall]").click();
      await textHas(page, "#save-status", /Trying on Iron Wall\. Buy it to save this look\./);
      await page.locator("#save").click();
      await textHas(page, "#save-status", /Not saved: buy Iron Wall first/);
      assert.equal(posted, null);
      await page.locator("label[for=title-none]").click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: shots + "/viewer-shop-" + s.name + ".png", fullPage: true });
      await page.locator("#tab-pets").click();
      await checkedIs(page, "#pet-none", true);
      assert.equal(await page.getByRole("button", { name: "Buy Dragon for $300" }).isDisabled(), true);
      const buyMouse = page.getByRole("button", { name: "Buy Mouse for $10" });
      await buyMouse.click();
      assert.equal(await buyMouse.textContent(), "Confirm: spend $10");
      assert.equal(bought, null, "the first click only asks to confirm");
      await buyMouse.click();
      await waitText(page, "#pet-status", /price changed/);
      assert.deepEqual(bought, { kind: "pet", id: "mouse", price: 10 });
      await textIs(page, "#pet-status", "Not bought: the price changed to $11. Check it and buy again.");
      const buyMouse2 = page.getByRole("button", { name: "Buy Mouse for $11" });
      await buyMouse2.click();
      await buyMouse2.click();
      await waitText(page, "#pet-status", /^Bought/);
      assert.deepEqual(bought, { kind: "pet", id: "mouse", price: 11 });
      await checkedIs(page, "#pet-mouse", true);
      await textIs(page, "#stat-dollars", "$1");
      await textHas(page, "#pet-note", /you own 1, you have \$1/);
      await countIs(page, "#items-petcolor input", 9, "eight pet colors and none");
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: shots + "/viewer-pets-" + s.name + ".png", fullPage: true });
      await page.locator("#tab-fighter").click();
      assert.deepEqual(
        await page.locator("#upgrade-presets button").allTextContents(),
        [
          "Balanced",
          "Brawler",
          "Lucky striker",
          "Iron wall",
          "Glass cannon",
          "Tank",
          "Counter-puncher",
          "Duelist",
          "Gambler",
          "Ghost",
          "Bruiser",
          "Sharpshooter",
        ],
        "all twelve presets",
      );
      await textHas(page, "#upgrade-list", /Next level costs 1 point/);
      await page.getByRole("button", { name: "Put a level into Power for 1 point" }).click();
      await page.getByRole("button", { name: "Put a level into Power for 1 point" }).click();
      await page.getByRole("button", { name: "Put a level into Luck for 1 point" }).click();
      assert.equal(
        await page.getByRole("button", { name: "Put a level into Guard for 1 point" }).isDisabled(),
        true,
        "no points left",
      );
      await textHas(page, "#save-status", /unsaved/i);
      if (s.name === "1280")
        await page.screenshot({ path: shots + "/viewer-signed-in-editing-1280.png", fullPage: true });
      await page.locator("#save").click();
      await waitText(page, "#save-status", /^Saved/);
      assert.deepEqual(posted, {
        avatar: "adventurer",
        color: "#34d399",
        defaultAbility: "heal",
        stats: { power: 2, guard: 0, luck: 1, crit: 0, dodge: 0, counter: 0, vitality: 0 },
        hat: "cap",
        pet: "mouse",
        recolor: "",
        petColor: "",
        accessory: "",
        trail: "",
        winEffect: "",
        taunt: "",
        title: "",
        build: 0,
      }); // the saved ability is kept as is
      await textHas(page, "#upgrade-list", /2 \/ 16 \+1/, "the mouse adds +1 power past the points");
      await textHas(page, "#upgrade-list", /\+12% damage dealt \(1 from your pet\)/, "plain numbers, pet included");
      await noOverflow(page, "viewer signed-in " + s.name);
      if (s.name !== "1280") {
        // phones: explanation tables wrap instead of scrolling sideways, and the fighter bar stays at the bottom while picking
        await page.locator("#tab-rules").click();
        for (const w of await page.locator(".table-wrap:has(.prose-table)").all())
          assert.ok(await w.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), "duel table fits at " + s.name);
        await page.locator("#tab-ranks").click();
        await visibleIs(page, "#leaderboard th.col-char", false, "no Character column on phones");
        assert.ok(await fitsWrap(page, "#leaderboard"), "leaderboard fits without sideways scrolling at " + s.name);
        await page.locator("#tab-fighter").click();
        await page.locator("#upgrade-list").evaluate((n) => n.scrollIntoView({ block: "start" }));
        const bar = await box(page, ".hero-card"),
          vh = page.viewportSize()!.height; // newPage sets a viewport
        assert.ok(
          Math.abs(bar.y) <= 1 && bar.height < vh / 2,
          "preview bar sticks to the top of the screen at " + s.name + ": " + JSON.stringify(bar),
        );
        const up = await box(page, "#upgrade-list");
        assert.ok(up.y >= bar.y + bar.height - 1, "the picked section scrolls clear of the preview bar");
        await page.screenshot({ path: shots + "/viewer-signed-in-picking-" + s.name + ".png" });
      }
      await page.screenshot({ path: shots + "/viewer-signed-in-" + s.name + ".png", fullPage: true });
    });

  // 3a. A purchase the server took but whose answer the page can't read: the page says it may have gone through and
  // doesn't offer the same buy again.
  await withPage(sizes[0], async (page) => {
    let buys = 0;
    await page.route("**/api/shop/nesszerra", async (r) => {
      if (r.request().method() === "GET") return r.continue();
      buys++;
      return json(r, { ok: true, reason: "bought" }); // no dollars or owned: unreadable to the page
    });
    await stubViewer(page, myFighter({ dollars: 12 }), board);
    await page.goto(base + "/?channel=nesszerra");
    await page.waitForSelector("#save:not([hidden])");
    await page.locator("#tab-pets").click();
    const buyMouse = page.getByRole("button", { name: "Buy Mouse for $10" });
    await buyMouse.click();
    await buyMouse.click();
    await waitText(page, "#pet-status", /may have gone through/);
    await textIs(
      page,
      "#pet-status",
      "Your purchase may have gone through, but this page couldn't read the answer. Reload the page to check.",
    );
    assert.equal(await buyMouse.isDisabled(), true, "no second buy while the first may have gone through");
    assert.equal(buys, 1);
  });

  // 3b. First run: back from Twitch sign-in with no fighter, save one, then the next step until the first duel.
  for (const s of sizes)
    await withPage(s, async (page) => {
      let saved: Loose = null; // Loose: the saved profile, sent back by field
      await stubViewer(
        page,
        (r) => {
          if (r.request().method() !== "POST") return json(r, saved);
          saved = { ...user, username: user.login, ...r.request().postDataJSON(), elo: 1000, wins: 0, losses: 0 };
          return json(r, { profile: saved, revision: 3 });
        },
        board.filter((p) => p.userId !== user.id),
      );
      await page.goto(base + "/?channel=nesszerra&signed_in=1");
      await waitText(page, "#save-status", /^Signed in/);
      await textIs(page, "#save-status", "Signed in as Viewer_One. Pick a fighter and save.");
      assert.equal(new URL(page.url()).search, "?channel=nesszerra", "the signed_in flag is gone from the address");
      await hidden(page, "#next-step");
      await page.locator("label[for=char-adventurer]").click();
      await page.locator("#save").click();
      await page.waitForSelector("#next-step:not([hidden])");
      await textIs(
        page,
        "#next-step",
        "Saved. Next: in nesszerra's chat, type !challenge @friend. They answer !fight.",
      );
      await textIs(page, "#save-status", "", "the next step replaces the plain saved line");
      if (s.name !== "1280") {
        const bar = await box(page, ".hero-card"),
          vh = page.viewportSize()!.height; // newPage sets a viewport
        assert.ok(bar.height < vh / 2, "preview bar with the next step still fits at " + s.name);
      }
      await shot(page, "viewer-first-run-" + s.name, false);
    });

  // 3c. Your own sprite: a picture becomes a pixel sprite, the AI redraw replaces it, and it goes to the mods.
  //     Only the viewer's own approved sprite is in their character list.
  for (const s of sizes)
    await withPage(s, async (page) => {
      const ball = (w: number, h: number) =>
        makePng(w, h, {
          pixel: (x, y) =>
            (x - w / 2) ** 2 + (y - h / 2) ** 2 < (h / 3) ** 2
              ? Math.abs(y - h / 2) < h / 20
                ? [30, 40, 220, 255]
                : [220, 30, 30, 255]
              : [250, 250, 248, 255],
        });
      const spritePng = makePng(48, 64, {
        pixel: (x, y) => (x > 8 && x < 40 && y > 4 ? [220, 120, 30, 255] : [0, 0, 0, 0]),
      });
      let sent: Loose = null, // Loose: the posted sprite body, read by field below
        redraws = 0;
      const status = () => ({
        live: { id: "v-mine-aaaaaa", label: "Mine", url: "/api/assets/nesszerra/v-mine-aaaaaa", status: "live" },
        pending: sent ? { id: "v-my-cat-cccccc", label: sent.label, status: "pending", createdAt: now } : null,
        rejected: null,
        submitsLeft: sent ? 5 : 6,
        aiLeft: 3 - redraws,
        ai: { available: true, left: 3 - redraws },
        limits: { maxSide: 128, maxLabel: 24 },
      });
      await stubViewer(page, myFighter({ bonus: 0, checkins: 0, streak: 0, dollars: 0 }), board);
      await page.route("**/api/catalog/nesszerra", async (r) => {
        const real = await (await r.fetch()).json(),
          mine = (id: string, owner: string, label: string) => ({
            id,
            label,
            url: "/api/assets/nesszerra/" + id,
            frames: [{ x: 0, y: 0, w: 48, h: 64 }],
            fps: 8,
            anchor: { x: 0.5, y: 1 },
            mode: "single",
            combatFallback: "effects",
            animations: {},
            custom: true,
            owner,
          });
        return json(r, [...real, mine("v-mine-aaaaaa", user.id, "Mine"), mine("v-other-bbbbbb", "5005", "Not mine")]);
      });
      await page.route(/\/api\/(assets\/nesszerra\/v-|sprite\/nesszerra\/pending)/, (r) =>
        r.fulfill({ status: 200, contentType: "image/png", body: spritePng }),
      );
      await page.route("**/api/sprite/nesszerra/redraw", (r) => {
        redraws++;
        return json(r, { ok: true, image: Buffer.from(ball(256, 256)).toString("base64"), left: 3 - redraws });
      });
      await page.route("**/api/sprite/nesszerra", (r) => {
        if (r.request().method() === "POST") {
          sent = r.request().postDataJSON();
          return json(r, { ok: true, pending: status().pending }, 201);
        }
        return json(r, status());
      });
      await page.goto(base + "/?channel=nesszerra");
      await page.waitForSelector("#sprite-maker:not([hidden])");
      await countIs(page, "#char-v-mine-aaaaaa", 1, "the viewer's own sprite is in their list");
      await countIs(page, "#char-v-other-bbbbbb", 0, "another viewer's sprite is not");
      await textHas(page, "label[for=char-v-mine-aaaaaa]", /Your sprite/);
      await textHas(page, "#sprite-current", /Mine is approved/);
      await disabledIs(page, "#sprite-send", true);
      await page
        .locator("#sprite-file")
        .setInputFiles({ name: "my_cat.png", mimeType: "image/png", buffer: ball(300, 200) });
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#sprite-send")!.disabled); // the page has this element
      await valueIs(page, "#sprite-name", "my cat");
      await textHas(page, "#sprite-size", /^\d+ x 116 px$/);
      const painted = () =>
        page.locator("#sprite-canvas").evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; // a 2d canvas, so the context exists
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
          return n;
        });
      assert.ok((await painted()) > 1000, "the preview shows the sprite");
      await page.locator("#sprite-ai").click();
      await waitText(page, "#sprite-status", /^Redrawn/);
      await visibleIs(page, "#sprite-plain", true);
      await textIs(page, "#sprite-ai", "Redraw again");
      await textHas(page, "#sprite-note", /2 AI redraws/);
      await noOverflow(page, "viewer sprite maker " + s.name);
      await page.locator("#sprite-maker").scrollIntoViewIfNeeded();
      await page.locator("#sprite-maker").screenshot({ path: shots + "/viewer-sprite-maker-" + s.name + ".png" });
      await page.locator("#sprite-send").click();
      await waitText(page, "#sprite-current", /waiting for a mod/);
      await textHas(page, "#sprite-status", /^Sent/);
      assert.deepEqual([sent.label, sent.ai, sent.image.startsWith("iVBORw0KGgo")], ["my cat", true, true]);
      await textHas(page, "#sprite-current", /my cat is waiting for a mod/);
      await disabledIs(page, "#sprite-send", true, "the form clears after sending");
    });

  // 4. Signed in but not a moderator -> admin gate.
  await withPage(sizes[0], async (page) => {
    await stubSession(page, user);
    await page.route("**/api/access/nesszerra", (r) => json(r, { ...viewerAccess, reason: "Moderator role required" }));
    await page.route("**/api/access/viewer_one", (r) =>
      json(r, { error: "PixFray is not enabled for this channel", off: "not_enabled" }, 403),
    );
    await page.goto(base + "/admin/?channel=nesszerra");
    await waitText(page, "#gate-text", /Only nesszerra/);
    await hidden(page, "#app");
    await page.screenshot({ path: shots + "/admin-not-mod-390.png", fullPage: true });
    // The bare page names no channel: a viewer without a channel of their own is pointed to /start.
    await page.goto(base + "/admin/");
    await waitText(page, "#gate-text", /PixFray isn't on for viewer_one yet/);
    assert.equal(await page.locator("h1").first().textContent(), "PixFray mod controls");
    await countIs(page, '#gate-actions a[href="/start/"]', 1);
    await shot(page, "admin-bare-gate-390");
  });

  // 4b. A moderator whose arena fails to load gets a gate with a retry, not controls that have no arena behind them.
  await withPage(sizes[0], async (page) => {
    await stubSession(page, mod);
    await page.route("**/api/access/nesszerra", (r) => json(r, modAccess));
    await page.route("**/api/admin/nesszerra", (r) => json(r, { error: "room error" }, 500));
    await page.goto(base + "/admin/?channel=nesszerra");
    await waitText(page, "#gate-text", /Couldn't load the arena/);
    await hidden(page, "#app");
    await textIs(page, "#gate-actions button", "Try again");
  });

  // 5. Moderator admin (fully stubbed). Covers toggle, cancel, resets, config save, 409 conflict and revert.
  for (const s of sizes)
    for (const role of ["mod", "owner"]) {
      if (role === "owner" && s.name === "390") continue;
      await withPage(s, async (page) => {
        page.on("dialog", (d) => d.accept());
        let version = 3,
          conflictNext = false,
          reconnectNext = true,
          quickOff = false; // quickOff: the HP-fight abilities only matter when config.quickDuel is false
        let chatStatus = chatOn({ subscriptionId: "sub-1", lastNotificationAt: now - 4000, checkedAt: now - 600000 });
        const history = () => [
          {
            version: 3,
            config: { ...config, abilities: { ...config.abilities, heavy: { damage: 35, cooldownMs: 5000 } } },
            actorId: mod.id,
            at: now - 600000,
            note: "back to preset",
          },
          {
            version: 2,
            config: { ...config, abilities: { ...config.abilities, heavy: { damage: 30, cooldownMs: 5000 } } },
            actorId: "3003",
            at: now - 3600000,
            note: "heavier heavy",
          },
          { version: 1, config, actorId: "system", at: now - 86400000, note: "" },
        ];
        const snapshot = () => ({
          revision: 40 + posts.length,
          chatStatus,
          history: history(),
          customUsage: { count: 1, limit: 24, bytes: 48213 },
          config: quickOff ? { ...config, quickDuel: false } : config,
          configVersion: version,
          round: 7,
          players: [
            { ...board[0], hp: 62, lastSeen: now - 20000, registered: true, respawnAt: 0 },
            { ...board[1], hp: 85, lastSeen: now - 5000, registered: true, respawnAt: 0 },
            { ...board[2], hp: 0, lastSeen: now - 9000, registered: true, respawnAt: now + 60000 },
            {
              userId: "5005",
              username: "lurker",
              displayName: "lurker",
              avatar: "player",
              color: "#a78bfa",
              defaultAbility: "strike",
              hp: 100,
              elo: 1000,
              wins: 0,
              losses: 0,
              lastSeen: now - 120000,
              registered: false,
              respawnAt: 0,
            },
          ],
          duels: [
            {
              id: "d1",
              a: "3003",
              b: "1001",
              status: "active",
              createdAt: now - 20000,
              expiresAt: now + 10000,
              startedAt: now - 15000,
              lastActionAt: now - 3000,
              hp: { 3003: 62, 1001: 85 },
              rules: { maxHp: 100 },
              round: 7,
            },
            {
              id: "d2",
              a: "5005",
              b: "4004",
              status: "pending",
              createdAt: now - 5000,
              expiresAt: now + 25000,
              round: 0,
            },
          ],
        });
        const posts = await stubAdmin(page, {
          who: role === "owner" ? owner : mod,
          isOwner: role === "owner",
          access: { owner: role === "owner", moderator: role === "mod", canManage: true },
          lb: board,
          snapshot,
          post: (body, r) => {
            if (conflictNext) {
              conflictNext = false;
              version = 4;
              return json(r, { ok: false, reason: "config_version_conflict", error: "config_version_conflict" }, 409);
            }
            if (body.action === "config" || body.action === "rollbackConfig") version += 1;
            if (body.action === "connectChat") {
              if (reconnectNext) {
                reconnectNext = false;
                return json(
                  r,
                  {
                    error:
                      "Twitch rejected the chat subscription: missing authorization. Reconnect Twitch at /auth/login?connect=1, then click Connect chat.",
                    reconnect: "/auth/login?connect=1",
                  },
                  403,
                );
              }
              chatStatus = { ...chatStatus, connected: true, status: "enabled", subscriptionId: "sub-2" };
              return json(r, { ok: true, reason: "chat_connected", revision: 51, chatStatus });
            }
            if (body.action === "giftDollars")
              return json(r, {
                ok: true,
                reason: "dollars_gifted",
                username: "cara",
                displayName: "Cara",
                amount: body.payload.amount,
                dollars: 75,
              });
            if (body.action === "disconnectChat") {
              chatStatus = { ...chatStatus, connected: false, status: "disconnected", subscriptionId: "" };
              return json(r, { ok: true, reason: "chat_disconnected", revision: 52, chatStatus });
            }
            return json(r, { ok: true, reason: "ok", revision: 50 });
          },
        });
        await page.route("**/api/assets/nesszerra", (r) =>
          json(r, {
            items: [
              {
                id: "c-mascot",
                label: "Mascot",
                frames: [
                  { x: 0, y: 0, w: 128, h: 128 },
                  { x: 128, y: 0, w: 128, h: 128 },
                ],
                animations: { attack: [{ x: 256, y: 0, w: 128, h: 128 }] },
                bytes: 48213,
                createdBy: mod.id,
                createdAt: now - 7200000,
              },
            ],
            usage: { count: 1, limit: 24, bytes: 48213 },
            limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 24 },
          }),
        );
        const spriteRow = (id: string, label: string, extra: object) => ({
          id,
          userId: "3003",
          username: "top_dog",
          displayName: "top_dog",
          label,
          bytes: 900,
          width: 48,
          height: 64,
          createdAt: now - 600000,
          reviewedBy: "",
          reviewedAt: 0,
          ...extra,
        });
        await page.route("**/api/sprites/nesszerra", (r) =>
          json(r, {
            pending: [spriteRow("v-dog-aaaaaa", "Dog", { status: "pending", ai: true })],
            live: [
              spriteRow("v-cat-bbbbbb", "Cat", {
                status: "live",
                ai: false,
                reviewedBy: "Mod_Two",
                reviewedAt: now - 3600000,
              }),
            ],
          }),
        );
        await page.route("**/api/sprites/nesszerra/*", (r) =>
          r.fulfill({
            status: 200,
            contentType: "image/png",
            body: makePng(48, 64, { pixel: (x, y) => (x > 8 && x < 40 && y > 4 ? [120, 200, 60, 255] : [0, 0, 0, 0]) }),
          }),
        );
        await page.goto(base + "/admin/");
        await page.waitForSelector("#app:not([hidden])");
        await waitText(page, "#summary-title", /^Duels are live$/);
        await hidden(page, "#open-chat-setup", "no chat-setup shortcut while chat is live");
        await countIs(page, "#duels tbody tr", 2);
        await countIs(page, "#players tbody tr", 4);
        await countIs(page, "#ranks tbody tr", 3);
        await countIs(page, "#history tbody tr", 3);
        assert.match(
          (await page.locator("#history tbody tr").nth(1).textContent())!,
          /Heavy strike damage 35 HP → 30 HP/,
        );
        await textHas(page, "#usage-title", /1 of 24/);
        await visibleIs(page, "#dev-open", role === "owner"); // on the Live tab, shown first
        await textIs(page, "#dev-link", "Owner");
        const liveText = await text(page, "#panel-live"),
          headline = await page.locator("#stats, #summary-text, #meta").allTextContents();
        for (const jargon of ["state revision", "Rules version", "Live-fix"])
          assert.ok(!liveText.includes(jargon), 'no "' + jargon + '" on the Live tab');
        assert.ok(!/round/i.test(headline.join(" ")), "no global round number in the summary");
        await textHas(page, "#stats", /Twitch chat\s*Connected/);
        await textHas(page, "#stats", /Duels\s*On\s*accepting commands/);
        // the summary holds at most the one primary action; the stats and then the moderation buttons follow, all inside the 1280x800 fold
        await countIs(
          page,
          ".summary #toggle-duels, .summary #reset-health, .summary #reset-round",
          0,
          "moderation buttons are not in the summary",
        );
        await countIs(page, ".summary .btn-primary:visible", 0, "no primary action while chat works");
        assert.deepEqual(await page.locator("#panel-live .moderation button").evaluateAll((b) => b.map((x) => x.id)), [
          "toggle-duels",
          "reset-health",
          "reset-round",
        ]);
        await textIs(page, "#moderation-title", "Moderation");
        assert.ok(
          await page.locator(".moderation").evaluate(
            (n) => n.getBoundingClientRect().top > document.querySelector("#stats")!.getBoundingClientRect().bottom, // the page has this element
          ),
          "Moderation comes after the stats",
        );
        await textHas(page, "#meta", /^Signed in as (the broadcaster|a moderator)\.$/);
        await hidden(page, "#panel-chat", "only the Live tab shows at first");
        await page.click("#tab-chat");
        assert.equal(new URL(page.url()).hash, "#chat");
        // the OBS Browser Source link moved here from the viewer page
        assert.match(
          await page.locator("#obs-url").inputValue(),
          /\/overlay\.html\?channel=nesszerra&size=64&arena=1$/,
        );
        assert.match((await page.locator("#demo").getAttribute("href"))!, /arena=1&demo=1$/); // the page sets this attribute
        await hidden(page, "#se-health", "no StreamElements note before any command");
        await visibleIs(page, "#owner-chat", role === "owner");
        await textHas(page, "#chat-text", /Last chat message/);
        await textIs(page, "#connect-chat", "Reconnect chat");
        if (s.name === "1280") {
          // first try: Twitch says the broadcaster authorization is missing, so the page points at the reconnect link
          await page.click("#connect-chat");
          await waitText(page, "#chat-status", /Reconnect Twitch/);
          assert.equal(
            (await page.locator('#chat-status a[href="/auth/login?connect=1"]').count()) +
              (await page.locator('#owner-chat a[href="/auth/login?connect=1"]').count()) >=
              1,
            true,
          );
          await page.click("#connect-chat");
          await waitText(page, "#chat-status", /Chat connected/);
          assert.deepEqual(posts.filter((p) => p.action === "connectChat").length, 2);
          await page.click("#disconnect-chat"); // dialog auto-accepted
          await waitText(page, "#chat-status", /Chat disconnected/);
          assert.equal(posts.at(-1).action, "disconnectChat");
          // chat offline: the Live tab points at the fix instead of offering to pause
          await page.click("#tab-live");
          await waitText(page, "#summary-title", /^Waiting for chat$/);
          await visibleIs(page, "#open-chat-setup", true);
          await countIs(page, "#toggle-duels.btn-primary", 0, "one primary action");
          await countIs(page, ".summary .btn-primary:visible", 1, "the summary holds just the primary action");
          await textHas(page, "#stats", /Duels\s*Waiting\s*for chat/, 'Duels are not "On" while chat is down');
          await page.click("#open-chat-setup");
          await attrIs(page, "#tab-chat", "aria-selected", "true");
        }
        assert.ok(
          await page.evaluate(() =>
            // StubWindow: the WebSocket stub's list, not in lib.dom
            (window as unknown as StubWindow).__sockets.some((w) => w.url.endsWith("/api/live/nesszerra")),
          ),
          "live socket opened",
        );
        if ((await page.request.head(base + "/upload.js")).ok()) {
          // Lane D's uploader is mounted into the admin page
          await page.waitForFunction(
            () => !document.querySelector("#upload-root")!.textContent.includes("isn't available"), // the page has this element
          );
          await countIs(page, "#upload-root .status.error", 0, await text(page, "#upload-root"));
        }
        for (const tab of ["live", "players", "rules", "characters", "chat"]) {
          await page.click("#tab-" + tab);
          await visibleIs(page, "#panel-" + tab, true, tab + " panel shows");
          await countIs(page, "[role=tabpanel]:visible", 1, "one panel at a time");
          if (tab === "characters") {
            const panel = await page.locator("#panel-characters").innerText(),
              count = (re: RegExp) => (panel.match(re) || []).length;
            assert.equal(count(/custom character slots used/g), 1, "slot usage appears once on the Characters tab");
            assert.ok(count(/PNG only/g) <= 1 && count(/characters per channel/g) <= 1, "upload limits appear once");
            assert.ok(count(/1.5 MB|1.50 MB/g) <= 1, "the atlas size limit appears once");
            assert.match(panel, /Viewer sprites waiting for review \(1\)/);
            await countIs(page, "#sprite-pending tbody tr", 1);
            await textHas(page, "#tab-characters", /Characters \(1\)/);
          }
          if (tab === "rules") {
            await countIs(page, "#config-fields .config-group:visible", 5, "only the groups that apply show");
            await valueIs(page, "#cfg-petPriceLegendary", "900");
            await checkedIs(page, "#cfg-streakBonus", true);
            await countIs(page, "#cfg-abilities-strike-damage", 1, "the HP fight inputs stay in the form");
            await visibleIs(
              page,
              "#cfg-abilities-strike-damage",
              false,
              "HP fight abilities are hidden unless quick duels are off",
            );
            assert.ok(!/ability values apply/.test(await page.locator("#panel-rules").innerText()));
          }
          await shot(page, "admin-" + role + "-" + s.name + (tab === "live" ? "" : "-" + tab));
        }
        // arrow keys move between tabs
        await page.focus("#tab-chat");
        await page.keyboard.press("ArrowRight");
        await attrIs(page, "#tab-live", "aria-selected", "true");
        assert.equal(await page.evaluate(() => document.activeElement!.id), "tab-live"); // a page always has a focused element
        if (s.name === "390") {
          // phones: with unsaved rule changes the Save bar stays at the bottom of the screen
          await page.click("#tab-rules");
          await page.locator("#cfg-maxHp").fill("120");
          // the elements are on the page, so they have boxes; newPage sets a viewport
          const field = await box(page, "#cfg-maxHp"),
            bar = await box(page, "#config-bar"),
            vh = page.viewportSize()!.height; // as above
          assert.ok(
            bar.y + bar.height <= vh + 1 && bar.y > vh / 2,
            "Rules save bar sits at the bottom of the screen at 390",
          );
          assert.ok(field.y + field.height <= bar.y, "the field being edited is not hidden behind the bar");
          assert.equal(await page.locator("#config-save").isEnabled(), true);
          await page.screenshot({ path: shots + "/admin-" + role + "-390-rules-editing.png" });
        }
        if (s.name !== "1280" || role !== "mod") return;

        await page.locator("#toggle-duels").click();
        await page.waitForFunction(() => document.querySelector("#action-status")!.classList.contains("ok")); // the page has this element
        assert.deepEqual(posts.at(-1), {
          action: "config",
          payload: { patch: { enabled: false }, baseVersion: 3, note: "duels paused" },
        });
        await page.locator("#duels tbody tr").first().getByRole("button", { name: "Cancel duel" }).click();
        await waitText(page, "#action-status", /cancelled/);
        assert.deepEqual(posts.at(-1), { action: "cancelDuel", payload: { duelId: "d1" } });
        await page.locator("#reset-health").click();
        await page.waitForTimeout(150);
        assert.deepEqual(posts.at(-1), { action: "resetHealth" });
        await page.locator("#reset-round").click();
        await page.waitForTimeout(150);
        assert.deepEqual(posts.at(-1), { action: "resetRound" });
        await page.click("#tab-players");
        await page.locator("#ranks tbody tr").first().getByRole("button", { name: "Reset rank" }).click();
        await page.waitForTimeout(150);
        assert.deepEqual(posts.at(-1), { action: "resetRank", payload: { userId: "3003" } });
        await hidden(page, "#reset-all-ranks", "resetting every rank is the broadcaster's");
        await hidden(page, "#rotate-se", "a new StreamElements key is the broadcaster's");
        // mod gift: a Twitch name (with or without @) and a whole amount
        await page.locator("#gift-user").fill("@Cara");
        await page.locator("#gift-send").click();
        await textHas(page, "#gift-status", /whole number/);
        await page.locator("#gift-amount").fill("25");
        await page.locator("#gift-send").click();
        await waitText(page, "#gift-status", /^Gave/);
        assert.deepEqual(posts.at(-1), { action: "giftDollars", payload: { username: "Cara", amount: 25 } });
        await textIs(page, "#gift-status", "Gave $25 to Cara. They have $75 now.");
        // config: invalid value blocks save, valid value saves only the changed field
        await page.click("#tab-rules");
        await visibleIs(page, "#history", false, "version history starts collapsed");
        // hidden HP-fight inputs still round trip: saving another field sends only that field
        await page.locator("#cfg-maxHp").fill("120");
        await page.locator("#config-save").click();
        await waitText(page, "#config-status", /^Saved as version/);
        assert.deepEqual(posts.at(-1).payload.patch, { maxHp: 120 });
        await page.locator("#cfg-streakBonus").uncheck();
        await page.locator("#config-save").click();
        await waitText(page, "#config-status", /^Saved as version/);
        assert.deepEqual(posts.at(-1).payload.patch, { streakBonus: false });
        // with quick duels off the HP-fight group shows
        quickOff = true;
        await page.reload();
        await page.waitForSelector("#app:not([hidden])");
        await page.click("#tab-rules");
        await countIs(page, "#config-fields .config-group:visible", 6);
        assert.match(
          (await page.locator("#config-fields .config-group:visible").last().locator("legend").textContent())!,
          /HP fight abilities/,
        );
        const strike = page.locator("#cfg-abilities-strike-damage");
        await strike.fill("5000");
        await disabledIs(page, "#config-save", true);
        await textHas(page, "#config-status", /between 1 HP and 1000 HP/);
        await strike.fill("12");
        await page.locator("#cfg-abilities-strike-cooldownMs").fill("2.5");
        await page.locator("#config-note").fill("faster strikes");
        const base0 = version;
        await page.locator("#config-save").click();
        await waitText(page, "#config-status", /^Saved as version/);
        assert.deepEqual(posts.at(-1), {
          action: "config",
          payload: {
            patch: { abilities: { strike: { damage: 12, cooldownMs: 2500 } } },
            baseVersion: base0,
            note: "faster strikes",
          },
        });
        // 409: reload and explain
        conflictNext = true;
        await page.locator("#cfg-maxHp").fill("150");
        await page.locator("#config-save").click();
        await waitText(page, "#config-status", /someone else saved/);
        await textHas(page, "#config-status", /Max health 100 HP → 150 HP/);
        await page.locator("#config-form").screenshot({ path: shots + "/admin-config-conflict-1280.png" });
        await page.click("#history-title");
        await page
          .locator("#history tbody tr")
          .nth(1)
          .getByRole("button", { name: /Revert to v2/ })
          .click();
        await page.waitForTimeout(200);
        assert.deepEqual(posts.at(-1), { action: "rollbackConfig", payload: { version: 2 } });
        if (s.name === "1280") {
          await page.click("#tab-chat");
          // Duel announcements save to the channel config (live overlays follow it); the link stays the same.
          await page.click("#obs-setup details > summary"); // overlay options start folded
          await valueIs(page, "#announce", "off");
          await page.selectOption("#announce", "top");
          await page.waitForFunction(
            () =>
              /within seconds/.test(document.querySelector("#announce-status")!.textContent) && // the page has this element
              // the page has this select (querySelector<HTMLSelectElement> clashes with the Worker Element type)
              !(document.querySelector("#announce") as unknown as HTMLSelectElement).disabled,
          );
          assert.deepEqual(posts.at(-1).payload.patch, { announce: "top" });
          assert.match(
            await page.locator("#obs-url").inputValue(),
            /size=\d+&arena=1$/,
            "the settings are not in the link",
          );
          // The on-stream limit is a channel setting too; out-of-range values are refused before posting.
          await page.fill("#cap", "9");
          await page.locator("#cap").dispatchEvent("change");
          await textHas(page, "#cap-status", /15 to 100/);
          await page.fill("#cap", "30");
          await page.locator("#cap").dispatchEvent("change");
          await page.waitForFunction(
            () =>
              /up to 30/.test(document.querySelector("#cap-status")!.textContent) && // the page has this element
              !document.querySelector<HTMLInputElement>("#cap")!.disabled, // the page has this element
          );
          assert.deepEqual(posts.at(-1).payload.patch, { maxOnStream: 30 });
        }
      });
    }
  // 6. StreamElements is the chat source but no command has reached this site: the Stream setup tab warns.
  for (const se of [
    {
      lastCommandAt: 0,
      rejectedAt: 0,
      expect: /No StreamElements command has reached \S+ with this key yet.*test site.*!no/,
      warn: true,
      live: "Waiting for the first chat command",
      stat: "No commands yet",
    },
    {
      lastCommandAt: Date.now() - 125000,
      rejectedAt: 0,
      expect: /Last StreamElements command reached \S+ 2 min ago/,
      warn: false,
      live: "Duels are live",
      stat: "Working",
    },
    {
      lastCommandAt: now - 120000,
      rejectedAt: now - 30000,
      expect: /old key and was refused/,
      warn: true,
      live: "StreamElements is sending an old key",
      stat: "Old key",
    },
  ])
    await withPage(sizes[0], async (page) => {
      const chatStatus = chatOn({
        source: "streamelements",
        subscriptionId: "se-streamelements",
        lastNotificationAt: se.lastCommandAt,
      });
      const names = { challenge: "!challenge", accept: "!fight", decline: "!no" },
        fields = { names, lastCommandAt: se.lastCommandAt, rejectedAt: se.rejectedAt };
      const streamelements = seSetup(fields, ["challenge", "accept", "decline"]);
      await stubAdmin(page, { lb: board, snapshot: () => ({ revision: 5, chatStatus, streamelements }) });
      await page.goto(base + "/admin/#chat");
      await page.waitForSelector("#se-health:not([hidden])");
      await textHas(page, "#se-health", se.expect);
      assert.equal(await page.locator("#se-health").evaluate((n) => n.classList.contains("warning")), se.warn);
      await hidden(page, "#checkin-test"); // check-in test mode is for the site channel only
      // the Live tab tells the same story as Stream setup
      await textIs(page, "#summary-title", se.live);
      await textHas(page, "#stats", new RegExp("StreamElements\\s*" + se.stat));
      // the reply column never shows the key; Copy reply still copies the whole line
      const previews = await page.locator("#se-table code.reply-preview").allTextContents();
      assert.equal(previews.length, 3);
      for (const p of previews) {
        assert.match(p, /^\$\(customapi \/api\/se\/nesszerra\/\w+\?k=…\)$/);
        assert.ok(!p.includes("kkkk"));
      }
      if (se.warn && !se.rejectedAt) {
        await page.locator("#se-health").scrollIntoViewIfNeeded();
        await page.screenshot({ path: shots + "/admin-se-warning-1280.png" });
      }
    });
  // 7. Setup checklist: live states from /api/admin, the Live tab points at the first unfinished step, the Duel-module tick saves.
  for (const s of sizes)
    await withPage(s, async (page) => {
      const actions = ["challenge", "accept", "decline", "rematch", "top", "elo", "help"];
      let overlays = 0,
        duelModuleOff = false,
        seen: Record<string, number> = { challenge: Date.now() - 125000, decline: Date.now() - 125000 };
      const chatStatus = chatOn({ source: "streamelements", subscriptionId: "se-streamelements" });
      const posts = await stubAdmin(page, {
        lb: board,
        snapshot: () => ({
          revision: 5,
          chatStatus,
          streamelements: seSetup({ lastCommandAt: now - 120000, seen, duelModuleOff }, actions),
          overlays,
          modsReady: true,
          checkinTestAllowed: true,
        }),
        post: (body, r) => {
          if (body.action === "setDuelModuleOff") duelModuleOff = body.value;
          if (body.action !== "checkinTest") return null;
          const checkinTest = body.value ? { until: Date.now() + 15 * 60000, by: "ModMia" } : null;
          return json(r, { ok: true, checkinTest });
        },
      });
      await page.goto(base + "/admin/");
      await page.waitForSelector("#setup-next:not([hidden])");
      await textIs(page, "#setup-next", "Stream setup: 0 of 3 steps done. Next: open the overlay in OBS.");
      await page.click("#setup-next a");
      await visibleIs(page, "#panel-chat", true);
      assert.equal(await page.evaluate(() => document.activeElement!.id), "check-overlay"); // a page always has a focused element
      await textIs(page, "#check-title", "Stream setup: 0 of 3 steps done");
      await textHas(page, "#check-overlay", /To do.*No overlay is open/s);
      await textHas(
        page,
        "#check-commands",
        /2 of 7 commands have reached PixFray\. Not used yet: !accept, !rematch, !top, !elo, !help\./,
      );
      await textHas(page, "#check-mods", /Done.*moderators of nesszerra can sign in/s);
      assert.deepEqual(await page.locator("#se-table [data-seen]").allTextContents(), [
        "Working · 2 min ago",
        "Not used yet",
        "Working · 2 min ago",
        "Not used yet",
        "Not used yet",
        "Not used yet",
        "Not used yet",
      ]);
      // the command table uses the full step width: badges stay on one line, nothing is cut off, narrow screens scroll inside the wrap
      const wrap = page.locator("#se-table").locator("xpath=.."),
        wrapBox = (await wrap.boundingBox())!; // the element is on the page, so it has a box
      for (const b of await page.locator("#se-table [data-seen] .badge").all())
        assert.ok((await b.boundingBox())!.height < 28, "status badge on one line at " + s.name);
      const lastCell = (await page.locator("#se-table tbody tr").first().locator("td").last().boundingBox())!;
      if (s.name === "1280") {
        assert.ok(wrapBox.width > 800, "table is wider than the reading column, got " + wrapBox.width);
        assert.ok(await wrap.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), "table is not clipped at 1280");
        assert.ok(lastCell.x + lastCell.width <= wrapBox.x + wrapBox.width + 1, "Response to paste column fits");
        const prose = await box(page, "#se-setup > ol");
        assert.ok(prose.width <= 720, "step prose stays at reading width, got " + prose.width);
      } else {
        // phones stack each command into rows, so nothing scrolls sideways and Copy reply stays in reach
        assert.ok(
          await wrap.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
          "stacked table does not scroll sideways at 390",
        );
        const copy = await page
          .locator("#se-table tbody tr")
          .first()
          .getByRole("button", { name: /Copy/ })
          .boundingBox();
        assert.ok(
          copy && copy.x + copy.width <= wrapBox.x + wrapBox.width + 1 && copy.height >= 44,
          "Copy reply fits and is a 44px target at 390",
        );
      }
      await shot(page, "admin-checklist-" + s.name, "#setup-check");
      // tick the Duel module box; then an overlay connects and !fight arrives, and the next refresh finishes setup
      await page.check("#duel-module-off");
      await waitText(page, "#check-status", /Duel module is off/);
      assert.deepEqual(posts.at(-1), { action: "setDuelModuleOff", value: true });
      // the page has this element
      await waitText(page, "#check-duel", /^\s*Done/); // after the reload
      overlays = 1;
      seen = { ...seen, accept: now };
      await page.waitForFunction(
        () => document.querySelector("#check-title")!.textContent === "Stream setup is done", // the page has this element
        null,
        { timeout: 15000 },
      );
      await textHas(page, "#check-overlay", /1 overlay is connected right now/);
      await hidden(page, "#setup-next");
      // check-in test mode: on for 15 minutes, then off again
      await textIs(page, "#checkin-test-title", "Test !checkin while offline");
      await page.click("#checkin-test-toggle");
      await waitText(page, "#checkin-test-title", /^!checkin test mode is on$/);
      assert.deepEqual(posts.at(-1), { action: "checkinTest", value: true });
      await textHas(
        page,
        "#checkin-test-text",
        /^Until .+ \(turned on by ModMia\), !checkin answers while the stream is offline/,
      );
      await textIs(page, "#checkin-test-toggle", "Turn test mode off");
      await shot(page, "admin-checkin-test-" + s.name, "#checkin-test");
      await page.click("#checkin-test-toggle");
      await waitText(page, "#checkin-test-title", /^Test !checkin while offline$/);
      assert.deepEqual(posts.at(-1), { action: "checkinTest", value: false });
    });
  // 7a. Chat commands: shown while the PixFray bot reads chat; add, edit, delete and set a counter.
  for (const s of sizes)
    await withPage(s, async (page) => {
      let data = {
        commands: [
          { name: "!nt", reply: "Nesszerra has tried $(count nt) times!" },
          { name: "!tablet", reply: "60Wx45H (CTL-472 700hz custom firmware)" },
        ],
        counters: [{ name: "nt", value: 1 }],
        max: 50,
      };
      const chatStatus = chatOn({ source: "twitch", checkedAt: now });
      const posts = await stubAdmin(page, {
        lb: board,
        post: (body, r) => {
          if (body.action === "saveCommand" && body.payload.name === "!fray")
            return json(r, { ok: false, reason: "command_name_taken", error: "command_name_taken" }, 400);
          if (body.action === "saveCommand")
            data = {
              ...data,
              commands: [
                ...data.commands.filter((c) => c.name !== body.payload.oldName && c.name !== body.payload.name),
                { name: body.payload.name, reply: body.payload.reply },
              ].sort((a, b) => a.name.localeCompare(b.name)),
            };
          if (body.action === "deleteCommand")
            data = { ...data, commands: data.commands.filter((c) => c.name !== body.payload.name) };
          if (body.action === "setCounter")
            data = {
              ...data,
              counters: data.counters.map((c) =>
                c.name === body.payload.name ? { ...c, value: body.payload.value } : c,
              ),
            };
          return json(r, { ok: true, botCommands: data });
        },
        snapshot: () => ({
          revision: 5,
          chatStatus,
          streamelements: seSetup({ duelModuleOff: true }),
          overlays: 1,
          modsReady: true,
          checkinTestAllowed: true,
          ...botSite,
          botCommands: data,
          botStatus: {
            heardAt: now - 60000,
            heard: "alice !fray",
            sentAt: now - 60000,
            sent: 41,
            failedAt: now - 30000,
            failed: 1,
            failedReason: "msg_duplicate",
            failedText: "the same line twice within 30 s (msg_duplicate)",
            heldAt: 0,
            heldReason: "",
            recent: 0,
            cap: 18,
          },
        }),
      });
      await page.goto(base + "/admin/");
      await page.click("#tab-chat");
      await page.waitForSelector("#bot-commands:not([hidden])");
      // a bot site: the bot step replaces the StreamElements steps, Done while the bot reads chat
      await textIs(page, "#check-bot [data-badge]", "Done");
      await textHas(
        page,
        "#check-bot [data-detail]",
        /^The PixFray bot \(pixfray\) reads your chat and answers the duel commands\. It last answered a command \d+ (s|min) ago\. Type \/mod pixfray/,
      );
      for (const id of ["#check-duel", "#check-commands"]) await hidden(page, id, id + " hidden on a bot site");
      await textIs(page, "#check-title", "Stream setup is done");
      assert.deepEqual(await page.locator("#bot-commands-table tbody td:first-child").allTextContents(), [
        "!nt",
        "!tablet",
      ]);
      // the bot's health: a drop newer than the last sent reply is a warning
      await textHas(
        page,
        "#bot-health",
        /^Bot: last command \d+ (s|min) ago \(alice !fray\), last reply sent \d+ (s|min) ago\. 41 sent, 1 dropped\. The last reply was dropped \d+ (s|min) ago: the same line twice within 30 s \(msg_duplicate\)\. Type !fray debug/,
      );
      await attrIs(page, "#bot-health", "class", "small callout warning");
      await valueIs(page, '[data-counter="nt"]', "1");
      // add (a PixFray name is refused with a reason), edit with a rename, set a counter, delete
      await page.fill("#command-name", "fray");
      await page.fill("#command-reply", "x");
      await page.click("#command-save");
      await waitText(page, "#command-status", /PixFray already uses that name/);
      await page.fill("#command-name", "Sens");
      await page.fill("#command-reply", "0.14 3600dpi");
      await page.click("#command-save");
      await waitText(page, "#command-status", /Added !sens/);
      assert.deepEqual(posts.at(-1), { action: "saveCommand", payload: { name: "!sens", reply: "0.14 3600dpi" } });
      await valueIs(page, "#command-name", "");
      await page.click('[data-edit="!tablet"]');
      await textIs(page, "#command-save", "Save changes");
      await page.fill("#command-name", "!pad");
      await page.click("#command-save");
      await waitText(page, "#command-status", /Saved !pad/);
      assert.deepEqual(posts.at(-1), {
        action: "saveCommand",
        payload: { name: "!pad", reply: "60Wx45H (CTL-472 700hz custom firmware)", oldName: "!tablet" },
      });
      assert.deepEqual(await page.locator("#bot-commands-table tbody td:first-child").allTextContents(), [
        "!nt",
        "!pad",
        "!sens",
      ]);
      await page.fill('[data-counter="nt"]', "20");
      await page.click('[data-save-counter="nt"]');
      await waitText(page, "#counter-status", /Counter nt is 20 now/);
      assert.deepEqual(posts.at(-1), { action: "setCounter", payload: { name: "nt", value: 20 } });
      await noOverflow(page, "chat commands " + s.name);
      for (const id of ["#bot-commands-table", "#bot-counters-table"])
        assert.ok(await fitsWrap(page, id), id + " does not scroll sideways at " + s.name);
      await page.locator("#bot-commands").screenshot({ path: shots + "/admin-bot-commands-" + s.name + ".png" });
      page.once("dialog", (d) => d.accept());
      await page.click('[data-delete="!sens"]');
      await waitText(page, "#command-status", /Deleted !sens/);
      assert.deepEqual(posts.at(-1), { action: "deleteCommand", payload: { name: "!sens" } });
    });
  // 7b. Step 4 "Let your moderators help" reads differently for the broadcaster, the site owner on another channel, and a moderator.
  {
    const ownerAccess = { owner: true, moderator: false, canManage: true };
    const reconnect = "/auth/login?channel=newstreamer&connect=mods";
    const cases = [
      {
        name: "owner, not connected",
        channel: "miolafff",
        session: owner,
        access: ownerAccess,
        extra: { modsReady: false },
        text: /^Mod access isn't connected\. miolafff has to connect it from their own Stream setup page\.$/,
        badge: "Optional",
      },
      {
        name: "owner, connected",
        channel: "miolafff",
        session: owner,
        access: ownerAccess,
        extra: { modsReady: true },
        text: /^Twitch moderators of miolafff can sign in and use this page\.$/,
        badge: "Done",
      },
      {
        name: "owner, expired",
        channel: "miolafff",
        session: owner,
        access: ownerAccess,
        extra: { modsReady: false, modsLapsed: true },
        text: /^Mod access expired\. miolafff has to reconnect it from their own Stream setup page\.$/,
        badge: "Expired",
      },
      {
        name: "broadcaster, not connected",
        channel: "newstreamer",
        session: newstreamer,
        access: broadcasterAccess,
        extra: { modsReady: false },
        text: /^Your Twitch moderators can't sign in yet\. PixFray needs permission to read your moderator list\. Connect mod access$/,
        badge: "Optional",
        link: ["Connect mod access", reconnect],
      },
      {
        name: "broadcaster, expired",
        channel: "newstreamer",
        session: newstreamer,
        access: broadcasterAccess,
        extra: { modsReady: false, modsLapsed: true },
        text: /^Mod access expired, so your Twitch moderators can't sign in until you reconnect it\. Reconnect mod access$/,
        badge: "Expired",
        link: ["Reconnect mod access", reconnect],
      },
      {
        name: "moderator, not connected, duels paused",
        channel: "miolafff",
        session: mod,
        access: modAccess,
        extra: { modsReady: false },
        paused: true,
        text: /^Mod access isn't connected\. Ask miolafff to connect it\.$/,
        badge: "Optional",
      },
    ];
    for (const c of cases)
      for (const s of sizes)
        await withPage(s, async (page) => {
          const ch = c.channel;
          await stubAdmin(page, {
            channel: ch,
            who: c.session,
            isOwner: c.session === owner,
            access: c.access,
            snapshot: () => ({
              config: { ...config, enabled: !c.paused },
              streamelements: null,
              overlays: 0,
              channelState: "on",
              ...c.extra,
            }),
          });
          await page.goto(base + "/admin/?channel=" + ch + "#chat");
          await page.waitForSelector("#app:not([hidden])");
          await page.waitForFunction(() => document.querySelector("#check-mods [data-detail]")!.textContent.length > 0); // the page has this element
          const detail = (await text(page, "#check-mods [data-detail]")).trim();
          assert.match(detail, c.text, c.name + " " + s.name);
          assert.ok(!/Only \w+ can open this page/.test(detail), c.name + ": the old wording is gone");
          await textIs(page, "#check-mods [data-badge]", c.badge, c.name + " badge");
          if (c.link) {
            assert.equal(await text(page, "#check-mods a"), c.link[0]);
            assert.equal(await page.locator("#check-mods a").getAttribute("href"), c.link[1]);
          } else await countIs(page, "#check-mods a", 0, c.name + ": no connect link for this viewer");
          if (c.paused) {
            await page.click("#tab-live");
            await textHas(page, "#stats", /Duels\s*Paused\s*commands ignored/);
          }
          if (s.name === "1280" && /owner, not/.test(c.name))
            await page.locator("#check-mods").screenshot({ path: shots + "/admin-step4-owner-1280.png" });
        });
  }
  // 7c. The bot step for a signed-up channel: the broadcaster gets Add the PixFray bot (the one primary button while it's
  // next), coming back with bot=allowed connects chat by itself, and a mod is told to ask the broadcaster.
  {
    const ch = "newstreamer";
    const cases = [
      { name: "broadcaster", session: newstreamer, access: broadcasterAccess, query: "" },
      {
        name: "broadcaster back with bot=allowed",
        session: newstreamer,
        access: broadcasterAccess,
        query: "&bot=allowed",
      },
      { name: "moderator", session: mod, access: modAccess, query: "" },
    ];
    for (const c of cases)
      for (const s of sizes)
        await withPage(s, async (page) => {
          let chatStatus: object = disconnected;
          const posts = await stubAdmin(page, {
            channel: ch,
            who: c.session,
            access: c.access,
            snapshot: () => ({
              chatStatus,
              streamelements: seSetup(),
              overlays: 1,
              modsReady: true,
              channelState: "on",
              ...botSite,
            }),
            post: (_body, r) => {
              chatStatus = chatOn({ source: "twitch", createdAt: now });
              return json(r, { ok: true, chatStatus });
            },
          });
          await page.goto(base + "/admin/?channel=" + ch + c.query + "#chat");
          await page.waitForSelector("#app:not([hidden])");
          await page.waitForFunction(() => document.querySelector("#check-bot [data-detail]")!.textContent.length > 0); // the page has this element
          for (const id of ["#check-duel", "#check-commands"]) await hidden(page, id, c.name + ": " + id + " hidden");
          await visibleIs(page, "#chat-box", true, c.name + ": the chat connection shows on a signed-up channel");
          if (c.query) {
            await waitText(page, "#check-bot [data-badge]", /^Done$/);
            assert.deepEqual(posts, [{ action: "connectChat" }], "bot=allowed connects chat once");
            assert.equal(new URL(page.url()).searchParams.get("bot"), null, "the flag leaves the address");
            await textHas(page, "#bot-status", /Chat connected/);
            await textIs(page, "#check-title", "Stream setup is done");
            await attrIs(page, "#copy", "class", "btn btn-primary", "Copy link is primary again");
          } else if (c.access === broadcasterAccess) {
            await textIs(page, "#check-bot [data-badge]", "To do");
            await textIs(page, "#check-title", "Stream setup: 1 of 2 steps done");
            const add = page.locator("#bot-actions a");
            assert.equal(await add.textContent(), "Add the PixFray bot");
            assert.equal(await add.getAttribute("href"), "/auth/login?channel=newstreamer&connect=bot");
            await countIs(page, "#panel-chat .btn-primary", 1, "one primary button");
            assert.equal(await add.getAttribute("class"), "btn btn-primary");
            await textHas(page, "#setup-next", /Next: add the PixFray bot to your chat\./);
            await shot(page, "admin-bot-step-" + s.name, "#check-bot");
          } else {
            await textHas(
              page,
              "#check-bot [data-detail]",
              /^Ask newstreamer to open this page and click Add the PixFray bot, or to type \/mod pixfray/,
            );
            await page.click("#bot-actions button");
            await waitText(page, "#check-bot [data-badge]", /^Done$/);
            assert.deepEqual(posts, [{ action: "connectChat" }]);
          }
        });
  }
  // 7d. Channel point rewards on a signed-up channel: the broadcaster allows them first, then adds and deletes rewards
  // (five at most); a moderator reads the rewards and redemptions without controls.
  {
    const ch = "newstreamer",
      login = "/auth/login?channel=newstreamer&connect=points";
    const cases = [
      { name: "broadcaster, not allowed yet", session: newstreamer, access: broadcasterAccess, ready: false },
      { name: "broadcaster, allowed", session: newstreamer, access: broadcasterAccess, ready: true },
      { name: "moderator", session: mod, access: modAccess, ready: true },
      {
        name: "site owner, not allowed yet",
        session: owner,
        access: { owner: true, moderator: false, canManage: true },
        ready: false,
      },
    ];
    for (const c of cases)
      for (const s of sizes)
        await withPage(s, async (page) => {
          const limits = { titleMax: 45, costMax: 1000000, dollarsMax: 10000, maxRewards: 5 };
          let rewards = [
            {
              rewardId: "rw1",
              title: "PixFray $100",
              cost: 500,
              dollars: 100,
              status: "enabled",
              createdAt: now - 3600000,
            },
          ];
          const redemptions = [
            {
              id: "rd2",
              at: now - 60000,
              rewardId: "rw1",
              user: "alice",
              outcome: "granted",
              dollars: 100,
              marked: 200,
            },
            {
              id: "rd1",
              at: now - 120000,
              rewardId: "gone",
              user: "bob",
              outcome: "refunded",
              dollars: 0,
              marked: 401,
            },
          ];
          const posts = await stubAdmin(page, {
            channel: ch,
            who: c.session,
            access: c.access,
            snapshot: () => ({
              chatStatus: chatOn({ source: "twitch", createdAt: now }),
              streamelements: null,
              overlays: 1,
              modsReady: true,
              channelState: "on",
              ...botSite,
              points: { rewards, redemptions, limits },
              pointsLogin: login,
              pointsReady: c.ready,
            }),
            post: (body, r) => {
              if (body.action === "createPointReward" && body.payload.title === "Taken")
                return json(
                  r,
                  { ok: false, reason: "points_rejected", error: "Twitch refused the reward: duplicate" },
                  400,
                );
              if (body.action === "createPointReward")
                rewards = [
                  ...rewards,
                  { rewardId: "rw" + (rewards.length + 2), status: "enabled", createdAt: now, ...body.payload },
                ];
              if (body.action === "deletePointReward")
                rewards = rewards.filter((x) => x.rewardId !== body.payload.rewardId);
              return json(r, { ok: true, rewards, redemptions, limits });
            },
          });
          await page.goto(base + "/admin/?channel=" + ch + "#chat");
          await page.waitForSelector("#points:not([hidden])");
          assert.deepEqual(await page.locator("#points-table tbody tr").first().locator("td").allTextContents(), [
            "PixFray $100",
            "500",
            "$100",
            c.name === "moderator" ? "" : "Delete",
          ]);
          assert.deepEqual(
            await page.locator("#points-redemptions tbody td:nth-child(4)").allTextContents(),
            [
              "Style dollars added",
              "No saved fighter, points refunded. Twitch's request queue wasn't updated, so check it there",
            ],
            c.name + ": outcomes, and a refund Twitch refused",
          );
          assert.equal(
            await page.locator("#points-redemptions tbody td:nth-child(3)").nth(1).textContent(),
            "A deleted reward",
          );
          if (c.name === "moderator") {
            await hidden(page, "#points-form");
            await hidden(page, "#points-connect");
            await textIs(page, "#points-note", "Only newstreamer can add or delete rewards.");
          } else if (c.name === "site owner, not allowed yet") {
            await hidden(page, "#points-connect", "Twitch takes only the broadcaster's account");
            await hidden(page, "#points-form");
            await textIs(
              page,
              "#points-note",
              "newstreamer has to allow channel point rewards, signed in to Twitch as themself.",
            );
          } else if (!c.ready) {
            await hidden(page, "#points-form", "no form before the permission");
            await attrIs(page, "#points-login", "href", login);
            await textHas(page, "#points-connect-text", /^Twitch no longer lets PixFray manage these rewards\./);
          } else {
            await hidden(page, "#points-connect");
            await page.click("#points-add");
            await textIs(page, "#points-status", "Name the reward with 1 to 45 characters.", "checked before sending");
            await page.fill("#points-title-input", "Taken");
            await page.fill("#points-cost", "100");
            await page.fill("#points-dollars", "10");
            await page.click("#points-add");
            await waitText(page, "#points-status", /duplicate/);
            for (const n of [2, 3, 4, 5]) {
              await page.fill("#points-title-input", "Reward " + n);
              await page.fill("#points-cost", String(n * 100));
              await page.fill("#points-dollars", String(n * 10));
              await page.click("#points-add");
              await page.waitForFunction(
                (t) => document.querySelector("#points-status")!.textContent.startsWith("Added " + t), // the page has this element
                "Reward " + n,
              );
            }
            assert.deepEqual(posts.at(-1), {
              action: "createPointReward",
              payload: { title: "Reward 5", cost: 500, dollars: 50 },
            });
            await countIs(page, "#points-table tbody tr", 5);
            await disabledIs(page, "#points-add", true, "five rewards is the limit");
            await textIs(page, "#points-note", "5 of 5 rewards. Delete one to add another.");
            await noOverflow(page, "channel points " + s.name);
            for (const t of ["#points-table", "#points-redemptions"])
              assert.ok(await fitsWrap(page, t), t + " fits without sideways scrolling at " + s.name);
            await page.locator("#points").screenshot({ path: shots + "/admin-points-" + s.name + ".png" });
            page.once("dialog", (d) => d.accept());
            await page.click('[data-reward="rw1"]');
            await waitText(page, "#points-status", /^Deleted PixFray \$100\.$/);
            assert.deepEqual(posts.at(-1), { action: "deletePointReward", payload: { rewardId: "rw1" } });
            await disabledIs(page, "#points-add", false, "room for one more");
          }
        });
  }
  // 8. /start: open sign-up, and each reason Twitch sign-in can send someone back, at 1280/390.
  for (const s of sizes)
    await withPage(s, async (page) => {
      await page.goto(base + "/start/");
      await textIs(page, "#signup-title", "Sign in with the Twitch account you stream on");
      await attrIs(page, "#signup-actions a.btn-primary", "href", "/auth/login?signup=1");
      await countIs(page, "#signup-actions a", 1);
      await attrIs(
        page,
        "#ready-actions a.btn-primary",
        "href",
        "/auth/login?signup=1",
        "the closing band repeats the sign-in",
      );
      await hidden(page, "#signup-problem");
      assert.match((await page.locator("#source a").getAttribute("href"))!, /^https:\/\/github\.com\//); // the page sets this attribute
      const stage = await box(page, ".stage"),
        frame = await box(page, ".stage iframe");
      const want = s.name === "390" ? 1 : 4 / 3; // phones get a square crop: the fighters stay readable and every nameplate fits
      assert.ok(
        Math.abs(stage.width / stage.height - want) < 0.03,
        "demo stage is " + (s.name === "390" ? "1:1" : "4:3") + ", got " + stage.width + "x" + stage.height,
      );
      if (s.name === "1280")
        assert.ok(
          stage.width > 560 && stage.y + stage.height < 800,
          "demo stage sits beside the headline in the first screen at 1280, got " + JSON.stringify(stage),
        );
      assert.ok(
        Math.abs(frame.width - stage.width) < 4 && Math.abs(frame.height - stage.height) < 4,
        "overlay frame fills the stage",
      );
      assert.ok(
        await page.locator(".stage iframe").evaluate((f: HTMLIFrameElement) => f.offsetWidth >= 640),
        "overlay lays out at 640px or wider",
      );
      await page.waitForTimeout(5000); // let the demo fighters walk in before the screenshot
      await shot(page, "start-valid-" + s.name);
      // back from Twitch after cancelling the permission: offer setup without mod access, and drop ?error from the URL
      await page.goto(base + "/start/?error=denied");
      await page.waitForSelector("#signup-problem:not([hidden])");
      await textHas(page, "#signup-problem", /cancelled the Twitch permission/);
      assert.deepEqual(await hrefs(page, "#signup-actions a"), ["/auth/login?signup=1", "/auth/login?signup=1&mods=0"]);
      assert.equal(new URL(page.url()).search, "");
      if (s.name === "390") await page.locator("#signup").screenshot({ path: shots + "/start-denied-390.png" });
      for (const [error, re] of [
        ["full", /PixFray is full right now/],
        ["failed", /sign-in didn't finish/],
      ] as const) {
        await page.goto(base + "/start/?error=" + error);
        await page.waitForSelector("#signup-problem:not([hidden])");
        await textHas(page, "#signup-problem", re);
      }
      await page.goto(base + "/start/?invite=" + "ab".repeat(16));
      await hidden(page, "#signup-problem", "an old invite link opens the plain sign-up");
    });

  // 9. A signed-up channel's own admin page: connect mod access later, turn PixFray off and back on.
  for (const s of sizes)
    await withPage(s, async (page) => {
      let channelState = "on";
      const posts = await stubAdmin(page, {
        channel: "newstreamer",
        who: newstreamer,
        access: broadcasterAccess,
        snapshot: () => ({ streamelements: null, overlays: 0, modsReady: false, channelState }),
        post: (body, r) => {
          channelState = body.action === "pauseChannel" ? "paused" : "on";
          return json(r, { ok: true, channelState });
        },
      });
      page.on("dialog", (d) => d.accept());
      await page.goto(base + "/admin/?channel=newstreamer&mods=denied#chat");
      await page.waitForSelector("#app:not([hidden])");
      await waitText(page, "#check-status", /permission was cancelled/);
      assert.equal(new URL(page.url()).search, "?channel=newstreamer", "the mods flag is dropped from the URL");
      await attrIs(page, "#check-mods a", "href", "/auth/login?channel=newstreamer&connect=mods");
      await hidden(page, "#chat-box", "Twitch chat connection is for nesszerra only");
      await visibleIs(page, "#troubleshoot", true);
      assert.deepEqual(await page.locator("#checklist > li:not([hidden]) h3").allTextContents(), [
        "Add the overlay to OBS",
        "Turn off the StreamElements Duel module",
        "Add the chat commands to StreamElements",
        "Let your moderators help",
      ]);
      await textIs(page, "#summary-title", "Waiting for chat");
      await textHas(page, "#stats", /Duels\s*Waiting\s*for chat/);
      await visibleIs(page, "#channel-power", true);
      await hidden(page, "#paused-note");
      await page.click("#power-toggle");
      await page.waitForSelector("#paused-note:not([hidden])");
      assert.deepEqual(posts.at(-1), { action: "pauseChannel" });
      await textIs(page, "#power-title", "PixFray is off on newstreamer");
      await textIs(page, "#power-toggle", "Turn PixFray back on");
      await shot(page, "admin-paused-" + s.name, false);
      await page.locator("#channel-power").screenshot({ path: shots + "/admin-power-" + s.name + ".png" });
      await page.click("#power-toggle");
      await page.waitForSelector("#paused-note", { state: "hidden" });
      assert.deepEqual(posts.at(-1), { action: "resumeChannel" });
    });

  // 10. The viewer page of a channel that is off, or was never set up.
  await withPage(sizes[0], async (page) => {
    let off = "paused";
    await page.route("**/api/state/*", (r) => json(r, { error: "off", off }, 403));
    await page.goto(base + "/?channel=newstreamer");
    await page.waitForSelector("#off-note:not([hidden])");
    await textHas(page, "#off-note", /PixFray is off on newstreamer's channel right now/);
    await visibleIs(page, ".fighter-card", true);
    off = "not_enabled";
    await page.goto(base + "/?channel=nobodyhere");
    await page.waitForSelector("#off-note:not([hidden])");
    await textHas(page, "#off-note", /isn't set up on nobodyhere's channel/);
    await hidden(page, ".fighter-card");
    await shot(page, "viewer-not-set-up-390", false);
  });
  // 11. Builds: looking at another saved build is not an unsaved edit; leaving warns only after a real change.
  // 12. A paused channel: the signed-in viewer sees their fighter; saving and buying say they're closed.
  for (const paused of [false, true])
    await withPage(sizes[0], async (page) => {
      const look = {
        color: "#60a5fa",
        stats: { power: 0, guard: 0, luck: 0 },
        hat: "",
        pet: "",
        recolor: "",
        petColor: "",
        accessory: "",
        trail: "",
        winEffect: "",
        taunt: "",
        title: "",
      };
      await stubViewer(
        page,
        myFighter({
          ...look,
          avatar: "player",
          bonus: 0,
          dollars: 500,
          build: 0,
          owned: { pets: [], hats: [], slots: 2 },
          builds: [
            { ...look, avatar: "player" },
            { ...look, avatar: "adventurer", color: "#34d399" },
          ],
        }),
      );
      if (paused) await page.route("**/api/state/nesszerra", (r) => json(r, { error: "off", off: "paused" }, 403));
      await page.goto(base + "/?channel=nesszerra");
      await page.waitForSelector("#save:not([hidden])");
      const leaving = () =>
        page.evaluate(() => {
          const e = new Event("beforeunload", { cancelable: true });
          dispatchEvent(e);
          return e.defaultPrevented;
        });
      if (!paused) {
        assert.equal(await leaving(), false, "nothing edited yet");
        await page.locator("#build-list button.build").nth(1).click();
        await textHas(page, "#save-status", /Build 2 isn't on stream/);
        assert.equal(await leaving(), false, "only looking at build 2");
        await page.locator('.swatch[data-color="#f472b6"]').click();
        assert.equal(await leaving(), true, "build 2 was changed");
        await page.locator("#build-list button.build").nth(0).click();
        assert.equal(await leaving(), true, "the edit in build 2 is still unsaved");
      } else {
        await page.waitForSelector("#off-note:not([hidden])");
        await disabledIs(page, "#save", true);
        await textHas(
          page,
          "#save-status",
          /PixFray is off on this channel right now, so saving and buying are closed. Your fighter is kept./,
        );
        await hidden(page, "#next-step");
        await page.locator("#tab-shop").click();
        await page.locator('.jump a[href="#shop-title"]').click();
        assert.equal(
          await page.getByRole("button", { name: "Buy Iron Wall title for $15" }).isDisabled(),
          true,
          "buying is closed",
        );
        await shot(page, "viewer-paused-signed-in-1280", false);
      }
    });
  // 13. Every build slot bought: nothing is for sale, so the list holds the five builds and no stray text after them.
  await withPage(sizes[0], async (page) => {
    await stubViewer(
      page,
      myFighter({
        avatar: "player",
        color: "#60a5fa",
        stats: { power: 0, guard: 0, luck: 0 },
        bonus: 0,
        dollars: 500,
        build: 0,
        owned: { pets: [], hats: [], slots: 5 },
        builds: [{ avatar: "player", color: "#60a5fa" }],
      }),
    );
    await page.goto(base + "/?channel=nesszerra");
    await page.waitForSelector("#build-list button.build");
    await countIs(page, "#build-list > *", 5, "five builds and no buy button");
    assert.doesNotMatch(await text(page, "#build-list"), /null/, "no slot for sale leaves no text");
    await textIs(page, "#build-note", "(5 of 5)");
  });
  // /start: the sign-in line sits below the copy (beside the demo on wide screens), never over it.
  for (const size of sizes)
    await withPage(size, async (page) => {
      await page.goto(base + "/start/");
      await page.waitForFunction(() => document.querySelector("#signup-text")?.textContent.trim());
      const copy = await box(page, ".hero-copy"),
        card = await box(page, "#signup");
      const apart = card.x >= copy.x + copy.width || card.y >= copy.y + copy.height;
      assert.ok(apart, `start ${size.name}: sign-in card overlaps the copy`);
      assert.ok(copy.width >= Math.min(size.width * 0.5, 400), `start ${size.name}: copy squeezed to ${copy.width}px`);
      await noOverflow(page, "start " + size.name);
    });
  // The intro (the home page; /intro/ moves there): the loader finishes (WebGL or the text-only fallback), the headline
  // shows and nothing overflows while scrolling. A first visit offers the picker.
  for (const size of sizes)
    await withPage(size, async (page) => {
      await page.route("**/api/leaderboard/**", (r) => json(r, board));
      await page.goto(base + "/intro/");
      assert.equal(new URL(page.url()).pathname, "/", "the old /intro/ address moves to the home page");
      await attrIs(page, "#hero-actions .btn", "href", "/play/");
      await page.waitForFunction(() => document.querySelector("#loader")?.classList.contains("is-done"), null, {
        timeout: 30000,
      });
      assert.ok(await page.locator("h1").isVisible(), `intro ${size.name}: headline hidden`);
      for (const y of [0, 0.5, 1]) {
        await page.evaluate((f) => scrollTo(0, f * (document.documentElement.scrollHeight - innerHeight)), y);
        await page.waitForTimeout(300);
        await noOverflow(page, `intro ${size.name} at ${y}`);
      }
    });
  // a browser without WebGL2 gets the text-only page and this one deliberate error
  // (in dev, Vite's client also logs when it can't forward that error to the server)
  for (let i = errors.length - 1; i >= 0; i--)
    // i stays inside errors
    if (/WebGL2 is not available|Failed to send error to Vite server/.test(errors[i]!)) errors.splice(i, 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: viewer + admin UI at 1280/390, signed-out (real server), signed-in viewer save, mod gate, admin actions, config save/409/revert; no page errors.",
  );
} finally {
  await browser.close();
}
