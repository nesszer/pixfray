// Lane B UI test: viewer dashboard ("/") and mod controls ("/admin/") at 1280px and 390px.
// Signed-out runs against the real local server (`bunx cf dev` / vite); signed-in states stub /api/* with page.route.
// Usage: MINI_BASE_URL=http://127.0.0.1:5193 node tests/ui.mjs
import { chromeOptions } from "./chrome.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { enforceCsp } from "./csp-helper.mjs";
import { makePng } from "./upload-helpers.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const base = process.env.MINI_BASE_URL || "http://127.0.0.1:5173";
const shots = fileURLToPath(new URL("../screenshots", import.meta.url));
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch(chromeOptions());
const errors = [];
const sizes = [
  { name: "1280", width: 1280, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const now = Date.now();
const json = (route, data, status = 200) =>
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
  checkinPoints: 1,
  streakBonus: true,
  winDollars: 5,
  lossDollars: 3,
  giveEnabled: true,
  giveMaxPerStream: 100,
  giveMinDuels: 5,
  reminderMin: 0,
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
async function noOverflow(page, label) {
  const { sw, cw, wide } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll("body *")]
      .filter(
        (e) =>
          e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 &&
          !e.parentElement.closest(".table-wrap"),
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
async function newPage(viewport) {
  const context = await browser.newContext({ viewport });
  await enforceCsp(context);
  await context.addInitScript(() => {
    // no real live socket in stubbed runs
    window.__sockets = [];
    window.WebSocket = class {
      constructor(u) {
        this.url = u;
        window.__sockets.push(this);
      }
      send() {}
      close() {}
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return { context, page };
}
try {
  // 1. Signed out, real server (no Twitch credentials locally).
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    await page.goto(base + "/?channel=nesszerra");
    assert.match(await page.title(), /PixFray/);
    await page.waitForSelector("#characters input[name=character]");
    const count = await page.locator("#characters input[name=character]").count();
    assert.ok(count >= 5, "expected at least 5 characters, got " + count);
    assert.equal(await page.locator("#save").isHidden(), true);
    await page.waitForFunction(() => !document.querySelector("#leaderboard tbody").textContent.includes("Loading"));
    await page.waitForFunction(() => {
      const c = document.querySelector("#preview");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
      return false;
    });
    const session = await page.evaluate(() => fetch("/api/session").then((r) => r.json()));
    if (session.configured === false) assert.match(await page.locator("#signin-note").textContent(), /isn't set up/);
    else assert.equal(await page.locator("#save-signin").isVisible(), true);
    assert.equal(
      await page.locator('#who a[href^="/auth/login"]').count(),
      0,
      "one sign-in button: the fighter card has it",
    );
    assert.equal(
      await page.locator("#obs-setup").count(),
      0,
      "the OBS link lives in mod controls, not on the viewer page",
    );
    if (await page.locator("#leaderboard tr.empty").count())
      assert.match(
        await page.locator("#leaderboard tr.empty").textContent(),
        /To get on the board: sign in and save your fighter.*!challenge @viewer/,
      );
    await page.locator("#char-soldier").check({ force: true });
    assert.match(await page.locator("#preview-caption").textContent(), /Soldier/);
    // Character search and type filters.
    await page.fill("#char-search", "zomb");
    assert.equal(await page.locator("#characters .char-option:visible").count(), 1, "search finds the zombie");
    await page.fill("#char-search", "");
    await page.locator("#char-groups [data-group=robots]").click();
    const robots = await page
      .locator("#characters .char-option:visible label > span:not(.thumb):not(.tag)")
      .allTextContents();
    assert.ok(
      robots.length >= 3 && robots.some((t) => /robot/i.test(t)) && !robots.some((t) => /zombie/i.test(t)),
      "Robots & aliens filter: " + robots.join(", "),
    );
    assert.equal(await page.locator("#more-chars").isHidden(), true, "no Show all while filtered");
    await page.locator("#char-groups [data-group=all]").click();
    // Tabs: the rules link opens Rules; the hash picks the tab on load.
    assert.equal(await page.locator("#panel-shop").isHidden(), true);
    await page.locator('.hero-copy a[href="#duels"]').click();
    assert.equal(await page.locator("#tab-rules").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#duels").isVisible(), true);
    assert.equal(new URL(page.url()).hash, "#duels");
    await page.locator("#tab-shop").click();
    assert.equal(await page.locator("#panel-shop").isVisible(), true);
    assert.equal(await page.locator("#panel-ranks").isHidden(), true);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#tab-pets").getAttribute("aria-selected"), "true", "arrow keys move between tabs");
    assert.equal(new URL(page.url()).hash, "#pets");
    // Shop tiles and try-on while signed out: the preview wears it; buying needs a sign-in.
    await page.locator("#tab-shop").click();
    await page.locator('.jump a[href="#shop-trail"]').click();
    await page.waitForSelector("#trail-flames", { state: "attached" });
    await page.locator("label[for=trail-flames]").click();
    assert.match(
      await page.locator("#status-trail").textContent(),
      /Trying on Flames in the preview\. Sign in to buy it\./,
    );
    assert.equal(await page.locator("#play-win").isDisabled(), true, "no win effect or taunt yet");
    await page.locator('.jump a[href="#win-effects"]').click();
    await page.locator("label[for=effect-confetti]").click();
    assert.equal(await page.locator("#play-win").isDisabled(), false);
    assert.match(await page.locator("#preview").getAttribute("aria-label"), /Flames trail/);
    await page.locator("#tab-fighter").click();
    await noOverflow(page, "viewer signed-out " + s.name);
    await page.screenshot({ path: shots + "/viewer-signed-out-real-" + s.name + ".png", fullPage: true });
    await page.goto(base + "/admin/");
    await page.waitForFunction(() => !document.querySelector("#gate-text").textContent.includes("Checking"));
    assert.equal(await page.locator("#app").isHidden(), true);
    assert.match(await page.locator("#gate-text").textContent(), /Sign in|isn't set up/);
    await noOverflow(page, "admin signed-out " + s.name);
    await page.screenshot({ path: shots + "/admin-signed-out-real-" + s.name + ".png", fullPage: true });
    await context.close();
  }

  // 1b. /play/ asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    await page.goto(base + "/play/");
    await page.waitForSelector("#channel-list a");
    assert.equal(await page.locator("h1:visible").textContent(), "Which stream are you watching?");
    assert.equal(
      await page.locator(".topbar .nav-cta").getAttribute("href"),
      "/play/",
      "the picker is the current page, not a channel",
    );
    const links = await page.locator("#channel-list a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
    assert.deepEqual(links.slice(0, 2), ["/?channel=nesszerra", "/?channel=miolafff"], "built-in channels first");
    assert.equal(await page.locator("#fighter").isHidden(), true, "no fighter form until a channel is picked");
    assert.equal(await page.locator("#save-signin").isVisible(), false);
    await noOverflow(page, "channel picker " + s.name);
    await page.screenshot({ path: shots + "/viewer-picker-" + s.name + ".png", fullPage: true });
    // the search only finds channels with PixFray on; any other name gets this site's /start/ link to send its streamer
    await page.fill("#channel-q", "some_streamer");
    assert.equal(await page.locator("#channel-list li:visible").count(), 0, "rows filter as you type");
    const host = new URL(base).host;
    assert.ok(
      (await page.locator("#channel-status").textContent()).startsWith(
        `some_streamer isn't on ${host} yet. Send them this link to set it up: ${host}/start`,
      ),
    );
    assert.equal(await page.locator("#channel-status a").getAttribute("href"), "/start/");
    assert.match(
      await page.locator("#channel-status .invite-note").textContent(),
      /run their own copy of PixFray have it on their own site/,
    );
    assert.equal(await page.locator('a[href*="some_streamer"]').count(), 0, "no link to a channel without PixFray");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.click('#channel-status button:has-text("Copy invite link")');
    await page.waitForFunction(() => document.querySelector("#channel-status button").textContent === "Copied");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base + "/start/");
    await page.fill("#channel-q", "some streamer!");
    assert.equal(await page.locator("#channel-status").textContent(), "No channel with PixFray matches that name.");
    await page.fill("#channel-q", "some_streamer");
    await noOverflow(page, "channel search " + s.name);
    await page.screenshot({ path: shots + "/viewer-picker-search-" + s.name + ".png", fullPage: true });
    await page.fill("#channel-q", "https://www.twitch.tv/miolafff");
    assert.equal(await page.locator("#channel-list li:visible").count(), 1, "a pasted Twitch link finds the channel");
    await page.fill("#channel-q", "");
    assert.ok((await page.locator("#channel-list li:visible").count()) >= 2);
    await page.locator("#channel-list a", { hasText: "miolafff" }).click();
    await page.waitForSelector("#characters input[name=character]");
    assert.match(await page.locator("#hero-title").textContent(), /miolafff/);
    assert.equal(
      await page.locator(".topbar .nav-cta").getAttribute("href"),
      "/?channel=miolafff",
      '"Pick your fighter" keeps the channel',
    );
    assert.equal(await page.locator(".brand").getAttribute("href"), "/", "the brand goes home (the intro)");
    // the home page is the intro, and it offers the way back to the channel picked last
    await page.goto(base + "/");
    assert.equal(await page.locator("h1").first().textContent(), "Your Twitch chat, in the ring.");
    await page.waitForFunction(() => document.querySelector("#hero-actions .btn")?.textContent === "Back to miolafff");
    assert.equal(await page.locator("#hero-actions .btn").getAttribute("href"), "/?channel=miolafff");
    assert.equal(await page.locator('#hero-actions a[href="/play/"]').textContent(), "Pick another channel");
    await context.close();
  }
  // 1c. With many channels signed up, eight rows show and the rest are a search away.
  {
    const { context, page } = await newPage(sizes[0]);
    const many = ["nesszerra", "miolafff", ...Array.from({ length: 10 }, (_, i) => "streamer_" + i)];
    await page.route("**/api/picker", async (r) => {
      const real = await (await r.fetch()).json();
      return json(r, {
        ...real,
        channels: many.map((login) => real.channels.find((c) => c.login === login) || { login, top: [] }),
      });
    });
    await page.goto(base + "/play/");
    await page.waitForSelector("#channel-list a");
    assert.equal(await page.locator("#channel-list li:visible").count(), 8);
    assert.match(await page.locator("#channel-status").textContent(), /find the other 4 channels/);
    await page.fill("#channel-q", "streamer_9");
    assert.deepEqual(
      await page.locator("#channel-list li:visible a").evaluateAll((a) => a.map((x) => x.getAttribute("href"))),
      ["/?channel=streamer_9"],
    );
    assert.equal(await page.locator("#channel-status").textContent(), "");
    await page.press("#channel-q", "Enter");
    await page.waitForURL(/channel=streamer_9/);
    await context.close();
  }
  // 1d. A full site doesn't invite: the search points at running your own copy.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    await page.route("**/api/picker", async (r) => json(r, { ...(await (await r.fetch()).json()), full: true }));
    await page.goto(base + "/play/");
    await page.waitForSelector("#channel-list a");
    await page.fill("#channel-q", "some_streamer");
    assert.match(
      await page.locator("#channel-status").textContent(),
      /isn't on .* yet\. This site is full right now; they can run their own copy\./,
    );
    assert.equal(await page.locator("#channel-status a").getAttribute("href"), "/start/#source");
    assert.equal(await page.locator("#channel-status button").count(), 0, "no invite link to a full site");
    await noOverflow(page, "channel search full " + s.name);
    await page.locator(".landing-inner").screenshot({ path: shots + "/viewer-picker-full-" + s.name + ".png" });
    await context.close();
  }

  // 2. Signed out with Twitch configured (stubbed session): sign-in buttons show.
  {
    const { context, page } = await newPage(sizes[0]);
    await page.route("**/api/session", (r) =>
      json(r, { user: null, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.goto(base + "/?channel=nesszerra");
    await page.waitForSelector("#save-signin:visible");
    assert.equal(
      await page.locator('#who a[href^="/auth/login"]').count(),
      0,
      "no second sign-in button in the top bar",
    );
    await page.screenshot({ path: shots + "/viewer-signed-out-configured-1280.png", fullPage: false });
    await context.close();
  }

  // 2b. Character resets: a browser that signed in before is told the signed-out fighter isn't theirs, edits made
  // before signing in come back after it, and a viewer with no fighter here is offered the one from another channel.
  {
    const { context, page } = await newPage(sizes[1]);
    let signedIn = false;
    await page.route("**/api/session", (r) =>
      json(r, {
        user: signedIn ? user : null,
        owner: false,
        configured: true,
        channels: ["nesszerra"],
        productionEnabled: false,
      }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: false, canManage: false }));
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
    assert.equal(
      await page.locator("#save-signin").textContent(),
      "Sign in with Twitch to save",
      "a first visit gets the plain sign-in",
    );
    assert.equal(await page.locator("#save-status").textContent(), "");
    await page.evaluate(() => localStorage.setItem("pixfray:signed-in", "1"));
    await page.reload();
    await page.waitForFunction(() => /signed out/.test(document.querySelector("#save-status").textContent));
    assert.equal(await page.locator("#save-signin").textContent(), "Sign in to load your fighter");
    await page.locator("#char-soldier").check({ force: true });
    await page.locator("#save-signin").click();
    await page.waitForFunction(() =>
      /from before you signed in are back/.test(document.querySelector("#save-status").textContent),
    );
    assert.equal(await page.locator("#char-soldier").isChecked(), true, "the pick made while signed out came back");
    assert.equal(await page.locator("#others").isHidden(), true, "a restored draft is not replaced by an offer");
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
    assert.equal(await page.locator("#char-player").isChecked(), true);
    assert.match(await page.locator("#save-status").textContent(), /Copied your miolafff fighter/);
    await noOverflow(page, "fighter offer 390");
    await page.screenshot({ path: shots + "/viewer-others-offer-390.png", fullPage: false });
    await context.close();
  }

  // 3. Signed-in viewer (stubbed session/profile/leaderboard; catalog and state are real).
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    let posted = null,
      bought = null,
      repriced = false;
    // The first confirmed buy meets a price a mod just changed (Mouse $10 -> $11); the page reloads the shop list.
    await page.route("**/api/shop/nesszerra", async (r) => {
      if (r.request().method() === "GET") {
        if (!repriced) return r.continue();
        const res = await r.fetch(),
          list = await res.json();
        list.pets = list.pets.map((p) => (p.id === "mouse" ? { ...p, price: 11 } : p));
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
    await page.route("**/api/session", (r) =>
      json(r, { user, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: false, canManage: false }));
    await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, board));
    await page.route("**/api/profile/nesszerra", async (r) => {
      if (r.request().method() === "POST") {
        posted = r.request().postDataJSON();
        return json(r, {
          profile: { ...board[1], bonus: 1, checkins: 4, streak: 3, dollars: 12, ...posted },
          revision: 9,
        });
      }
      return json(r, {
        ...board[1],
        hp: 100,
        registered: true,
        respawnAt: 0,
        lastSeen: now,
        bonus: 1,
        checkins: 4,
        streak: 3,
        dollars: 12,
      });
    });
    await page.goto(base + "/?channel=nesszerra");
    await page.waitForSelector("#save:not([hidden])");
    assert.equal(await page.locator("#char-zombie").isChecked(), true);
    assert.equal(await page.locator("#color").inputValue(), "#f472b6");
    assert.equal(
      await page.locator("#swatches > :last-child").getAttribute("class"),
      "custom-color",
      "Custom comes after the preset colors",
    );
    assert.equal(await page.locator("input[name=ability]").count(), 0, "no ability picker with quick duels");
    assert.equal(await page.locator("#admin-link").isHidden(), true);
    assert.match(await page.locator("#stat-elo").textContent(), /1012/);
    assert.equal((await page.locator("#stat-streak").textContent()).trim(), "3");
    assert.equal(await page.locator("#stat-dollars").textContent(), "$12");
    assert.match(await page.locator("#cmd-give").textContent(), /up to \$100 per stream, after your first 5 duels/);
    await page.waitForSelector("#leaderboard tr.me", { state: "attached" });
    await page.locator("label[for=char-adventurer]").click();
    await page.locator('.swatch[data-color="#34d399"]').click();
    // Builds: one free slot; the next costs $60.
    assert.match(await page.locator("#build-list").textContent(), /Build 1\s*On stream/);
    assert.equal(
      await page.getByRole("button", { name: "Buy build slot 2 for $60" }).isDisabled(),
      true,
      "$12 is not enough for a slot",
    );
    // Hats and upgrades: 2 wins + 1 check-in point = 3 points; the crown needs 20 wins.
    assert.match(await page.locator("#points-note").textContent(), /3 of 3 points/);
    await page.locator("#tab-shop").click();
    assert.match(await page.locator("#shop-note").textContent(), /^You have \$12\./);
    assert.equal(await page.locator("#hats .char-option:has(#hat-crown)").getAttribute("class"), "char-option locked");
    await page.locator("label[for=hat-cap]").click();
    assert.ok((await page.locator("#upgrades-help").textContent()).includes("2 from wins and 1 from check-ins"));
    // Shop: hats past the wins can be bought; a pet buy needs a second click to confirm, then the pet is picked.
    const crown = page.getByRole("button", { name: /^Buy Crown hat for \$60, you need \$48 more$/ });
    assert.equal(await crown.isDisabled(), true, "$12 is not enough for the crown");
    assert.equal(await crown.textContent(), "Need $48 more", "an item out of reach says how far off it is");
    // Cosmetics: every price is the channel's config default; trying one on blocks Save until it's bought.
    // The shop shows one section at a time; its section links switch between them.
    assert.equal(await page.locator("#shop-accessory").isHidden(), true, "only the Hats section shows first");
    await page.locator('.jump a[href="#shop-accessory"]').click();
    assert.equal(await page.locator("#hat-picker").isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Buy Cape for $25" }).isDisabled(), true);
    await page.locator('.jump a[href="#shop-title"]').click();
    assert.equal(await page.locator(".jump a[aria-current]").textContent(), "Titles");
    assert.equal(await page.getByRole("button", { name: "Buy Iron Wall title for $15" }).isDisabled(), true);
    await page.locator("label[for=title-wall]").click();
    assert.match(await page.locator("#save-status").textContent(), /Trying on Iron Wall\. Buy it to save this look\./);
    await page.locator("#save").click();
    assert.match(await page.locator("#save-status").textContent(), /Not saved: buy Iron Wall first/);
    assert.equal(posted, null);
    await page.locator("label[for=title-none]").click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: shots + "/viewer-shop-" + s.name + ".png", fullPage: true });
    await page.locator("#tab-pets").click();
    assert.equal(await page.locator("#pet-none").isChecked(), true);
    assert.equal(await page.getByRole("button", { name: "Buy Dragon for $300" }).isDisabled(), true);
    const buyMouse = page.getByRole("button", { name: "Buy Mouse for $10" });
    await buyMouse.click();
    assert.equal(await buyMouse.textContent(), "Confirm: spend $10");
    assert.equal(bought, null, "the first click only asks to confirm");
    await buyMouse.click();
    await page.waitForFunction(() => /price changed/.test(document.querySelector("#pet-status").textContent));
    assert.deepEqual(bought, { kind: "pet", id: "mouse", price: 10 });
    assert.equal(
      await page.locator("#pet-status").textContent(),
      "Not bought: the price changed to $11. Check it and buy again.",
    );
    const buyMouse2 = page.getByRole("button", { name: "Buy Mouse for $11" });
    await buyMouse2.click();
    await buyMouse2.click();
    await page.waitForFunction(() => document.querySelector("#pet-status").textContent.startsWith("Bought"));
    assert.deepEqual(bought, { kind: "pet", id: "mouse", price: 11 });
    assert.equal(await page.locator("#pet-mouse").isChecked(), true);
    assert.equal(await page.locator("#stat-dollars").textContent(), "$1");
    assert.match(await page.locator("#pet-note").textContent(), /you own 1, you have \$1/);
    assert.equal(await page.locator("#items-petcolor input").count(), 9, "eight pet colors and none");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: shots + "/viewer-pets-" + s.name + ".png", fullPage: true });
    await page.locator("#tab-fighter").click();
    await page.getByRole("button", { name: "Put a point into Power" }).click();
    await page.getByRole("button", { name: "Put a point into Power" }).click();
    await page.getByRole("button", { name: "Put a point into Luck" }).click();
    assert.equal(
      await page.getByRole("button", { name: "Put a point into Guard" }).isDisabled(),
      true,
      "no points left",
    );
    assert.match(await page.locator("#save-status").textContent(), /unsaved/i);
    if (s.name === "1280")
      await page.screenshot({ path: shots + "/viewer-signed-in-editing-1280.png", fullPage: true });
    await page.locator("#save").click();
    await page.waitForFunction(() => document.querySelector("#save-status").textContent.startsWith("Saved"));
    assert.deepEqual(posted, {
      avatar: "adventurer",
      color: "#34d399",
      defaultAbility: "heal",
      stats: { power: 2, guard: 0, luck: 1 },
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
    assert.match(
      await page.locator("#upgrade-list").textContent(),
      /2 \/ 8 \+1/,
      "the mouse adds +1 power past the points",
    );
    assert.match(
      await page.locator("#upgrade-list").textContent(),
      /\+12% damage dealt \(1 from your pet\)/,
      "plain numbers, pet included",
    );
    await noOverflow(page, "viewer signed-in " + s.name);
    if (s.name !== "1280") {
      // phones: explanation tables wrap instead of scrolling sideways, and the fighter bar stays at the bottom while picking
      await page.locator("#tab-rules").click();
      for (const w of await page.locator(".table-wrap:has(.prose-table)").all())
        assert.ok(await w.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), "duel table fits at " + s.name);
      await page.locator("#tab-ranks").click();
      const lb = page.locator("#leaderboard");
      assert.equal(await lb.locator("th.col-char").isVisible(), false, "no Character column on phones");
      assert.ok(
        await lb.evaluate((t) => t.parentElement.scrollWidth <= t.parentElement.clientWidth + 1),
        "leaderboard fits without sideways scrolling at " + s.name,
      );
      await page.locator("#tab-fighter").click();
      await page.locator("#upgrade-list").evaluate((n) => n.scrollIntoView({ block: "start" }));
      const bar = await page.locator(".hero-card").boundingBox(),
        vh = page.viewportSize().height;
      assert.ok(
        Math.abs(bar.y) <= 1 && bar.height < vh / 2,
        "preview bar sticks to the top of the screen at " + s.name + ": " + JSON.stringify(bar),
      );
      const up = await page.locator("#upgrade-list").boundingBox();
      assert.ok(up.y >= bar.y + bar.height - 1, "the picked section scrolls clear of the preview bar");
      await page.screenshot({ path: shots + "/viewer-signed-in-picking-" + s.name + ".png" });
    }
    await page.screenshot({ path: shots + "/viewer-signed-in-" + s.name + ".png", fullPage: true });
    await context.close();
  }

  // 3b. First run: back from Twitch sign-in with no fighter, save one, then the next step until the first duel.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    let saved = null;
    await page.route("**/api/session", (r) =>
      json(r, { user, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: false, canManage: false }));
    await page.route("**/api/leaderboard/nesszerra*", (r) =>
      json(
        r,
        board.filter((p) => p.userId !== user.id),
      ),
    );
    await page.route("**/api/profile/nesszerra", async (r) => {
      if (r.request().method() === "POST") {
        saved = { ...user, username: user.login, ...r.request().postDataJSON(), elo: 1000, wins: 0, losses: 0 };
        return json(r, { profile: saved, revision: 3 });
      }
      return json(r, saved);
    });
    await page.goto(base + "/?channel=nesszerra&signed_in=1");
    await page.waitForFunction(() => document.querySelector("#save-status").textContent.startsWith("Signed in"));
    assert.equal(await page.locator("#save-status").textContent(), "Signed in as Viewer_One. Pick a fighter and save.");
    assert.equal(new URL(page.url()).search, "?channel=nesszerra", "the signed_in flag is gone from the address");
    assert.equal(await page.locator("#next-step").isHidden(), true);
    await page.locator("label[for=char-adventurer]").click();
    await page.locator("#save").click();
    await page.waitForSelector("#next-step:not([hidden])");
    assert.equal(
      await page.locator("#next-step").textContent(),
      "Saved. Next: in nesszerra's chat, type !challenge @friend. They answer !fight.",
    );
    assert.equal(await page.locator("#save-status").textContent(), "", "the next step replaces the plain saved line");
    if (s.name !== "1280") {
      const bar = await page.locator(".hero-card").boundingBox(),
        vh = page.viewportSize().height;
      assert.ok(bar.height < vh / 2, "preview bar with the next step still fits at " + s.name);
    }
    await noOverflow(page, "viewer first run " + s.name);
    await page.screenshot({ path: shots + "/viewer-first-run-" + s.name + ".png" });
    await context.close();
  }

  // 3c. Your own sprite: a picture becomes a pixel sprite, the AI redraw replaces it, and it goes to the mods.
  //     Only the viewer's own approved sprite is in their character list.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    const ball = (w, h) =>
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
    let sent = null,
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
    await page.route("**/api/session", (r) =>
      json(r, { user, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: false, canManage: false }));
    await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, board));
    await page.route("**/api/profile/nesszerra", (r) =>
      json(r, {
        ...board[1],
        hp: 100,
        registered: true,
        respawnAt: 0,
        lastSeen: now,
        bonus: 0,
        checkins: 0,
        streak: 0,
        dollars: 0,
      }),
    );
    await page.route("**/api/catalog/nesszerra", async (r) => {
      const real = await (await r.fetch()).json(),
        mine = (id, owner, label) => ({
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
    assert.equal(await page.locator("#char-v-mine-aaaaaa").count(), 1, "the viewer's own sprite is in their list");
    assert.equal(await page.locator("#char-v-other-bbbbbb").count(), 0, "another viewer's sprite is not");
    assert.match(await page.locator("label[for=char-v-mine-aaaaaa]").textContent(), /Your sprite/);
    assert.match(await page.locator("#sprite-current").textContent(), /Mine is approved/);
    assert.equal(await page.locator("#sprite-send").isDisabled(), true);
    await page
      .locator("#sprite-file")
      .setInputFiles({ name: "my_cat.png", mimeType: "image/png", buffer: ball(300, 200) });
    await page.waitForFunction(() => !document.querySelector("#sprite-send").disabled);
    assert.equal(await page.locator("#sprite-name").inputValue(), "my cat");
    assert.match(await page.locator("#sprite-size").textContent(), /^\d+ x 116 px$/);
    const painted = () =>
      page.locator("#sprite-canvas").evaluate((c) => {
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
        return n;
      });
    assert.ok((await painted()) > 1000, "the preview shows the sprite");
    await page.locator("#sprite-ai").click();
    await page.waitForFunction(() => document.querySelector("#sprite-status").textContent.startsWith("Redrawn"));
    assert.equal(await page.locator("#sprite-plain").isVisible(), true);
    assert.equal(await page.locator("#sprite-ai").textContent(), "Redraw again");
    assert.match(await page.locator("#sprite-note").textContent(), /2 AI redraws/);
    await noOverflow(page, "viewer sprite maker " + s.name);
    await page.locator("#sprite-maker").scrollIntoViewIfNeeded();
    await page.locator("#sprite-maker").screenshot({ path: shots + "/viewer-sprite-maker-" + s.name + ".png" });
    await page.locator("#sprite-send").click();
    await page.waitForFunction(() =>
      document.querySelector("#sprite-current").textContent.includes("waiting for a mod"),
    );
    assert.match(await page.locator("#sprite-status").textContent(), /^Sent/);
    assert.deepEqual([sent.label, sent.ai, sent.image.startsWith("iVBORw0KGgo")], ["my cat", true, true]);
    assert.match(await page.locator("#sprite-current").textContent(), /my cat is waiting for a mod/);
    assert.equal(await page.locator("#sprite-send").isDisabled(), true, "the form clears after sending");
    await context.close();
  }

  // 4. Signed in but not a moderator -> admin gate.
  {
    const { context, page } = await newPage(sizes[1]);
    await page.route("**/api/session", (r) =>
      json(r, { user, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) =>
      json(r, { owner: false, moderator: false, canManage: false, reason: "Moderator role required" }),
    );
    await page.route("**/api/access/viewer_one", (r) =>
      json(r, { error: "PixFray is not enabled for this channel", off: "not_enabled" }, 403),
    );
    await page.goto(base + "/admin/?channel=nesszerra");
    await page.waitForFunction(() => document.querySelector("#gate-text").textContent.includes("Only nesszerra"));
    assert.equal(await page.locator("#app").isHidden(), true);
    await page.screenshot({ path: shots + "/admin-not-mod-390.png", fullPage: true });
    // The bare page names no channel: a viewer without a channel of their own is pointed to /start.
    await page.goto(base + "/admin/");
    await page.waitForFunction(() =>
      document.querySelector("#gate-text").textContent.includes("PixFray isn't on for viewer_one yet"),
    );
    assert.equal(await page.locator("h1").first().textContent(), "PixFray mod controls");
    assert.equal(await page.locator('#gate-actions a[href="/start/"]').count(), 1);
    await noOverflow(page, "admin bare gate 390");
    await page.screenshot({ path: shots + "/admin-bare-gate-390.png", fullPage: true });
    await context.close();
  }

  // 5. Moderator admin (fully stubbed). Covers toggle, cancel, resets, config save, 409 conflict and revert.
  for (const s of sizes)
    for (const role of ["mod", "owner"]) {
      if (role === "owner" && s.name === "390") continue;
      const { context, page } = await newPage(s);
      page.on("dialog", (d) => d.accept());
      const posts = [];
      let version = 3,
        conflictNext = false,
        reconnectNext = true,
        quickOff = false; // quickOff: the HP-fight abilities only matter when config.quickDuel is false
      let chatStatus = {
        connected: true,
        status: "enabled",
        subscriptionId: "sub-1",
        createdAt: now - 86400000,
        lastNotificationAt: now - 4000,
        lastRevocationReason: "",
        checkedAt: now - 600000,
      };
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
        type: "snapshot",
        channel: "nesszerra",
        revision: 40 + posts.length,
        paused: false,
        chat: { connected: true, lastSeen: now - 4000, status: "enabled" },
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
        events: [],
      });
      await page.route("**/api/session", (r) =>
        json(r, {
          user: role === "owner" ? { id: "9009", login: "nesszerra", displayName: "nesszerra" } : mod,
          owner: role === "owner",
          configured: true,
          channels: ["nesszerra"],
          productionEnabled: false,
        }),
      );
      await page.route("**/api/access/nesszerra", (r) =>
        json(r, { owner: role === "owner", moderator: role === "mod", canManage: true }),
      );
      await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, board));
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
      const spriteRow = (id, label, extra) => ({
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
      await page.route("**/api/admin/nesszerra", async (r) => {
        if (r.request().method() === "GET")
          return json(r, {
            ...snapshot(),
            chatStatus,
            history: history(),
            customUsage: { count: 1, limit: 24, bytes: 48213 },
            access: { owner: role === "owner", moderator: role === "mod", canManage: true },
          });
        const body = r.request().postDataJSON();
        posts.push(body);
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
      });
      await page.goto(base + "/admin/");
      await page.waitForSelector("#app:not([hidden])");
      await page.waitForFunction(() => document.querySelector("#summary-title").textContent === "Duels are live");
      assert.equal(
        await page.locator("#open-chat-setup").isHidden(),
        true,
        "no chat-setup shortcut while chat is live",
      );
      assert.equal(await page.locator("#duels tbody tr").count(), 2);
      assert.equal(await page.locator("#players tbody tr").count(), 4);
      assert.equal(await page.locator("#ranks tbody tr").count(), 3);
      assert.equal(await page.locator("#history tbody tr").count(), 3);
      assert.match(await page.locator("#history tbody tr").nth(1).textContent(), /Heavy strike damage 35 HP → 30 HP/);
      assert.match(await page.locator("#usage-title").textContent(), /1 of 24/);
      assert.equal(await page.locator("#dev-open").isVisible(), role === "owner"); // on the Live tab, shown first
      assert.equal(await page.locator("#dev-link").textContent(), "Owner");
      const liveText = await page.locator("#panel-live").textContent(),
        headline = await page.locator("#stats, #summary-text, #meta").allTextContents();
      for (const jargon of ["state revision", "Rules version", "Live-fix"])
        assert.ok(!liveText.includes(jargon), 'no "' + jargon + '" on the Live tab');
      assert.ok(!/round/i.test(headline.join(" ")), "no global round number in the summary");
      assert.match(await page.locator("#stats").textContent(), /Twitch chat\s*Connected/);
      assert.match(await page.locator("#stats").textContent(), /Duels\s*On\s*accepting commands/);
      // the summary holds at most the one primary action; the stats and then the moderation buttons follow, all inside the 1280x800 fold
      assert.equal(
        await page.locator(".summary #toggle-duels, .summary #reset-health, .summary #reset-round").count(),
        0,
        "moderation buttons are not in the summary",
      );
      assert.equal(
        await page.locator(".summary .btn-primary:visible").count(),
        0,
        "no primary action while chat works",
      );
      assert.deepEqual(await page.locator("#panel-live .moderation button").evaluateAll((b) => b.map((x) => x.id)), [
        "toggle-duels",
        "reset-health",
        "reset-round",
      ]);
      assert.equal(await page.locator("#moderation-title").textContent(), "Moderation");
      assert.ok(
        await page
          .locator(".moderation")
          .evaluate(
            (n) => n.getBoundingClientRect().top > document.querySelector("#stats").getBoundingClientRect().bottom,
          ),
        "Moderation comes after the stats",
      );
      assert.match(await page.locator("#meta").textContent(), /^Signed in as (the broadcaster|a moderator)\.$/);
      assert.equal(await page.locator("#panel-chat").isHidden(), true, "only the Live tab shows at first");
      await page.click("#tab-chat");
      assert.equal(new URL(page.url()).hash, "#chat");
      // the OBS Browser Source link moved here from the viewer page
      assert.match(await page.locator("#obs-url").inputValue(), /\/overlay\.html\?channel=nesszerra&size=64&arena=1$/);
      assert.match(await page.locator("#demo").getAttribute("href"), /arena=1&demo=1$/);
      assert.equal(await page.locator("#se-health").isHidden(), true, "no StreamElements note before any command");
      assert.equal(await page.locator("#owner-chat").isVisible(), role === "owner");
      assert.match(await page.locator("#chat-text").textContent(), /Last chat message/);
      assert.equal(await page.locator("#connect-chat").textContent(), "Reconnect chat");
      if (s.name === "1280") {
        // first try: Twitch says the broadcaster authorization is missing, so the page points at the reconnect link
        await page.click("#connect-chat");
        await page.waitForFunction(() => /Reconnect Twitch/.test(document.querySelector("#chat-status").textContent));
        assert.equal(
          (await page.locator('#chat-status a[href="/auth/login?connect=1"]').count()) +
            (await page.locator('#owner-chat a[href="/auth/login?connect=1"]').count()) >=
            1,
          true,
        );
        await page.click("#connect-chat");
        await page.waitForFunction(() => /Chat connected/.test(document.querySelector("#chat-status").textContent));
        assert.deepEqual(posts.filter((p) => p.action === "connectChat").length, 2);
        await page.click("#disconnect-chat"); // dialog auto-accepted
        await page.waitForFunction(() => /Chat disconnected/.test(document.querySelector("#chat-status").textContent));
        assert.equal(posts.at(-1).action, "disconnectChat");
        // chat offline: the Live tab points at the fix instead of offering to pause
        await page.click("#tab-live");
        await page.waitForFunction(() => document.querySelector("#summary-title").textContent === "Waiting for chat");
        assert.equal(await page.locator("#open-chat-setup").isVisible(), true);
        assert.equal(await page.locator("#toggle-duels.btn-primary").count(), 0, "one primary action");
        assert.equal(
          await page.locator(".summary .btn-primary:visible").count(),
          1,
          "the summary holds just the primary action",
        );
        assert.match(
          await page.locator("#stats").textContent(),
          /Duels\s*Waiting\s*for chat/,
          'Duels are not "On" while chat is down',
        );
        await page.click("#open-chat-setup");
        assert.equal(await page.locator("#tab-chat").getAttribute("aria-selected"), "true");
      }
      assert.ok(
        await page.evaluate(() => window.__sockets.some((w) => w.url.endsWith("/api/live/nesszerra"))),
        "live socket opened",
      );
      if ((await page.request.head(base + "/upload.js")).ok()) {
        // Lane D's uploader is mounted into the admin page
        await page.waitForFunction(
          () => !document.querySelector("#upload-root").textContent.includes("isn't available"),
        );
        assert.equal(
          await page.locator("#upload-root .status.error").count(),
          0,
          await page.locator("#upload-root").textContent(),
        );
      }
      for (const tab of ["live", "players", "rules", "characters", "chat"]) {
        await page.click("#tab-" + tab);
        assert.equal(await page.locator("#panel-" + tab).isVisible(), true, tab + " panel shows");
        assert.equal(await page.locator("[role=tabpanel]:visible").count(), 1, "one panel at a time");
        if (tab === "characters") {
          const text = await page.locator("#panel-characters").innerText(),
            count = (re) => (text.match(re) || []).length;
          assert.equal(count(/custom character slots used/g), 1, "slot usage appears once on the Characters tab");
          assert.ok(count(/PNG only/g) <= 1 && count(/characters per channel/g) <= 1, "upload limits appear once");
          assert.ok(count(/1.5 MB|1.50 MB/g) <= 1, "the atlas size limit appears once");
          assert.match(text, /Viewer sprites waiting for review \(1\)/);
          assert.equal(await page.locator("#sprite-pending tbody tr").count(), 1);
          assert.match(await page.locator("#tab-characters").textContent(), /Characters \(1\)/);
        }
        if (tab === "rules") {
          assert.equal(
            await page.locator("#config-fields .config-group:visible").count(),
            5,
            "only the groups that apply show",
          );
          assert.equal(await page.locator("#cfg-petPriceLegendary").inputValue(), "900");
          assert.equal(await page.locator("#cfg-streakBonus").isChecked(), true);
          assert.equal(
            await page.locator("#cfg-abilities-strike-damage").count(),
            1,
            "the HP fight inputs stay in the form",
          );
          assert.equal(
            await page.locator("#cfg-abilities-strike-damage").isVisible(),
            false,
            "HP fight abilities are hidden unless quick duels are off",
          );
          assert.ok(!/ability values apply/.test(await page.locator("#panel-rules").innerText()));
        }
        await noOverflow(page, "admin " + role + " " + s.name + " " + tab);
        await page.screenshot({
          path: shots + "/admin-" + role + "-" + s.name + (tab === "live" ? "" : "-" + tab) + ".png",
          fullPage: true,
        });
      }
      // arrow keys move between tabs
      await page.focus("#tab-chat");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("#tab-live").getAttribute("aria-selected"), "true");
      assert.equal(await page.evaluate(() => document.activeElement.id), "tab-live");
      if (s.name === "390") {
        // phones: with unsaved rule changes the Save bar stays at the bottom of the screen
        await page.click("#tab-rules");
        await page.locator("#cfg-maxHp").fill("120");
        const field = await page.locator("#cfg-maxHp").boundingBox(),
          bar = await page.locator("#config-bar").boundingBox(),
          vh = page.viewportSize().height;
        assert.ok(
          bar.y + bar.height <= vh + 1 && bar.y > vh / 2,
          "Rules save bar sits at the bottom of the screen at 390",
        );
        assert.ok(field.y + field.height <= bar.y, "the field being edited is not hidden behind the bar");
        assert.equal(await page.locator("#config-save").isEnabled(), true);
        await page.screenshot({ path: shots + "/admin-" + role + "-390-rules-editing.png" });
      }
      if (s.name !== "1280" || role !== "mod") {
        await context.close();
        continue;
      }

      await page.locator("#toggle-duels").click();
      await page.waitForFunction(() => document.querySelector("#action-status").classList.contains("ok"));
      assert.deepEqual(posts.at(-1), {
        action: "config",
        payload: { patch: { enabled: false }, baseVersion: 3, note: "duels paused" },
      });
      await page.locator("#duels tbody tr").first().getByRole("button", { name: "Cancel duel" }).click();
      await page.waitForFunction(() => document.querySelector("#action-status").textContent.includes("cancelled"));
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
      assert.equal(
        await page.locator("#reset-all-ranks").isHidden(),
        true,
        "resetting every rank is the broadcaster's",
      );
      assert.equal(await page.locator("#rotate-se").isHidden(), true, "a new StreamElements key is the broadcaster's");
      // mod gift: a Twitch name (with or without @) and a whole amount
      await page.locator("#gift-user").fill("@Cara");
      await page.locator("#gift-send").click();
      assert.match(await page.locator("#gift-status").textContent(), /whole number/);
      await page.locator("#gift-amount").fill("25");
      await page.locator("#gift-send").click();
      await page.waitForFunction(() => document.querySelector("#gift-status").textContent.startsWith("Gave"));
      assert.deepEqual(posts.at(-1), { action: "giftDollars", payload: { username: "Cara", amount: 25 } });
      assert.equal(await page.locator("#gift-status").textContent(), "Gave $25 to Cara. They have $75 now.");
      // config: invalid value blocks save, valid value saves only the changed field
      await page.click("#tab-rules");
      assert.equal(await page.locator("#history").isVisible(), false, "version history starts collapsed");
      // hidden HP-fight inputs still round trip: saving another field sends only that field
      await page.locator("#cfg-maxHp").fill("120");
      await page.locator("#config-save").click();
      await page.waitForFunction(() =>
        document.querySelector("#config-status").textContent.startsWith("Saved as version"),
      );
      assert.deepEqual(posts.at(-1).payload.patch, { maxHp: 120 });
      await page.locator("#cfg-streakBonus").uncheck();
      await page.locator("#config-save").click();
      await page.waitForFunction(() =>
        document.querySelector("#config-status").textContent.startsWith("Saved as version"),
      );
      assert.deepEqual(posts.at(-1).payload.patch, { streakBonus: false });
      // with quick duels off the HP-fight group shows
      quickOff = true;
      await page.reload();
      await page.waitForSelector("#app:not([hidden])");
      await page.click("#tab-rules");
      assert.equal(await page.locator("#config-fields .config-group:visible").count(), 6);
      assert.match(
        await page.locator("#config-fields .config-group:visible").last().locator("legend").textContent(),
        /HP fight abilities/,
      );
      const strike = page.locator("#cfg-abilities-strike-damage");
      await strike.fill("5000");
      assert.equal(await page.locator("#config-save").isDisabled(), true);
      assert.match(await page.locator("#config-status").textContent(), /between 1 HP and 1000 HP/);
      await strike.fill("12");
      await page.locator("#cfg-abilities-strike-cooldownMs").fill("2.5");
      await page.locator("#config-note").fill("faster strikes");
      const base0 = version;
      await page.locator("#config-save").click();
      await page.waitForFunction(() =>
        document.querySelector("#config-status").textContent.startsWith("Saved as version"),
      );
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
      await page.waitForFunction(() =>
        document.querySelector("#config-status").textContent.includes("someone else saved"),
      );
      assert.match(await page.locator("#config-status").textContent(), /Max health 100 HP → 150 HP/);
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
        assert.equal(await page.locator("#announce").inputValue(), "off");
        await page.selectOption("#announce", "top");
        await page.waitForFunction(
          () =>
            /within seconds/.test(document.querySelector("#announce-status").textContent) &&
            !document.querySelector("#announce").disabled,
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
        assert.match(await page.locator("#cap-status").textContent(), /15 to 100/);
        await page.fill("#cap", "30");
        await page.locator("#cap").dispatchEvent("change");
        await page.waitForFunction(
          () =>
            /up to 30/.test(document.querySelector("#cap-status").textContent) &&
            !document.querySelector("#cap").disabled,
        );
        assert.deepEqual(posts.at(-1).payload.patch, { maxOnStream: 30 });
      }
      await context.close();
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
  ]) {
    const { context, page } = await newPage(sizes[0]);
    const chatStatus = {
      connected: true,
      source: "streamelements",
      status: "enabled",
      subscriptionId: "se-streamelements",
      createdAt: now - 86400000,
      lastNotificationAt: se.lastCommandAt,
      lastRevocationReason: "",
      checkedAt: 0,
    };
    const streamelements = {
      key: "k".repeat(48),
      names: { challenge: "!challenge", accept: "!fight", decline: "!no" },
      origin: base,
      lastCommandAt: se.lastCommandAt,
      rejectedAt: se.rejectedAt,
      commands: ["challenge", "accept", "decline"].map((action) => ({
        action,
        name: "!" + action,
        response: "$(customapi " + base + "/api/se/nesszerra/" + action + "?k=" + "k".repeat(48) + ")",
      })),
    };
    await page.route("**/api/session", (r) =>
      json(r, { user: mod, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: true, canManage: true }));
    await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, board));
    await page.route("**/api/assets/nesszerra", (r) =>
      json(r, {
        items: [],
        usage: { count: 0, limit: 8, bytes: 0 },
        limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
      }),
    );
    await page.route("**/api/admin/nesszerra", (r) =>
      json(r, {
        type: "snapshot",
        channel: "nesszerra",
        revision: 5,
        paused: false,
        chat: { connected: true, lastSeen: se.lastCommandAt, status: "enabled" },
        config,
        configVersion: 1,
        round: 1,
        players: [],
        duels: [],
        events: [],
        chatStatus,
        history: [{ version: 1, config, actorId: "system", at: now - 86400000, note: "" }],
        customUsage: { count: 0, limit: 8, bytes: 0 },
        streamelements,
        access: { owner: false, moderator: true, canManage: true },
      }),
    );
    await page.goto(base + "/admin/#chat");
    await page.waitForSelector("#se-health:not([hidden])");
    assert.match(await page.locator("#se-health").textContent(), se.expect);
    assert.equal(await page.locator("#se-health").evaluate((n) => n.classList.contains("warning")), se.warn);
    assert.equal(await page.locator("#checkin-test").isHidden(), true); // check-in test mode is for the site channel only
    // the Live tab tells the same story as Stream setup
    assert.equal(await page.locator("#summary-title").textContent(), se.live);
    assert.match(await page.locator("#stats").textContent(), new RegExp("StreamElements\\s*" + se.stat));
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
    await context.close();
  }
  // 7. Setup checklist: live states from /api/admin, the Live tab points at the first unfinished step, the Duel-module tick saves.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    const actions = ["challenge", "accept", "decline", "rematch", "top", "elo", "help"];
    let overlays = 0,
      duelModuleOff = false,
      seen = { challenge: Date.now() - 125000, decline: Date.now() - 125000 };
    const posts = [];
    const chatStatus = {
      connected: true,
      source: "streamelements",
      status: "enabled",
      subscriptionId: "se-streamelements",
      createdAt: now - 86400000,
      lastNotificationAt: now - 120000,
      lastRevocationReason: "",
      checkedAt: 0,
    };
    const streamelements = () => ({
      key: "k".repeat(48),
      names: {},
      origin: base,
      lastCommandAt: now - 120000,
      rejectedAt: 0,
      seen,
      duelModuleOff,
      timerText: "x",
      commands: actions.map((action) => ({
        action,
        name: "!" + action,
        response: "$(customapi " + base + "/api/se/nesszerra/" + action + "?k=" + "k".repeat(48) + ")",
      })),
    });
    await page.route("**/api/session", (r) =>
      json(r, { user: mod, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: true, canManage: true }));
    await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, board));
    await page.route("**/api/assets/nesszerra", (r) =>
      json(r, {
        items: [],
        usage: { count: 0, limit: 8, bytes: 0 },
        limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
      }),
    );
    await page.route("**/api/admin/nesszerra", (r) => {
      if (r.request().method() === "POST") {
        const body = r.request().postDataJSON();
        posts.push(body);
        if (body.action === "setDuelModuleOff") duelModuleOff = body.value;
        if (body.action === "checkinTest")
          return json(r, {
            ok: true,
            checkinTest: body.value ? { until: Date.now() + 15 * 60000, by: "ModMia" } : null,
          });
        return json(r, { ok: true });
      }
      return json(r, {
        type: "snapshot",
        channel: "nesszerra",
        revision: 5,
        paused: false,
        chat: { connected: true, lastSeen: now, status: "enabled" },
        config,
        configVersion: 1,
        round: 1,
        players: [],
        duels: [],
        events: [],
        chatStatus,
        history: [{ version: 1, config, actorId: "system", at: now - 86400000, note: "" }],
        customUsage: { count: 0, limit: 8, bytes: 0 },
        streamelements: streamelements(),
        overlays,
        modsReady: true,
        checkinTestAllowed: true,
        access: { owner: false, moderator: true, canManage: true },
      });
    });
    await page.goto(base + "/admin/");
    await page.waitForSelector("#setup-next:not([hidden])");
    assert.equal(
      await page.locator("#setup-next").textContent(),
      "Stream setup: 0 of 3 steps done. Next: open the overlay in OBS.",
    );
    await page.click("#setup-next a");
    assert.equal(await page.locator("#panel-chat").isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "check-overlay");
    assert.equal(await page.locator("#check-title").textContent(), "Stream setup: 0 of 3 steps done");
    assert.match(await page.locator("#check-overlay").textContent(), /To do.*No overlay is open/s);
    assert.match(
      await page.locator("#check-commands").textContent(),
      /2 of 7 commands have reached PixFray\. Not used yet: !accept, !rematch, !top, !elo, !help\./,
    );
    assert.match(await page.locator("#check-mods").textContent(), /Done.*moderators of nesszerra can sign in/s);
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
      wrapBox = await wrap.boundingBox();
    for (const b of await page.locator("#se-table [data-seen] .badge").all())
      assert.ok((await b.boundingBox()).height < 28, "status badge on one line at " + s.name);
    const lastCell = await page.locator("#se-table tbody tr").first().locator("td").last().boundingBox();
    if (s.name === "1280") {
      assert.ok(wrapBox.width > 800, "table is wider than the reading column, got " + wrapBox.width);
      assert.ok(await wrap.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), "table is not clipped at 1280");
      assert.ok(lastCell.x + lastCell.width <= wrapBox.x + wrapBox.width + 1, "Response to paste column fits");
      const prose = await page.locator("#se-setup > ol").boundingBox();
      assert.ok(prose.width <= 720, "step prose stays at reading width, got " + prose.width);
    } else {
      // phones stack each command into rows, so nothing scrolls sideways and Copy reply stays in reach
      assert.ok(
        await wrap.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        "stacked table does not scroll sideways at 390",
      );
      const copy = await page.locator("#se-table tbody tr").first().getByRole("button", { name: /Copy/ }).boundingBox();
      assert.ok(
        copy && copy.x + copy.width <= wrapBox.x + wrapBox.width + 1 && copy.height >= 44,
        "Copy reply fits and is a 44px target at 390",
      );
    }
    await noOverflow(page, "setup checklist " + s.name);
    await page.locator("#setup-check").screenshot({ path: shots + "/admin-checklist-" + s.name + ".png" });
    // tick the Duel module box; then an overlay connects and !fight arrives, and the next refresh finishes setup
    await page.check("#duel-module-off");
    await page.waitForFunction(() => /Duel module is off/.test(document.querySelector("#check-status").textContent));
    assert.deepEqual(posts.at(-1), { action: "setDuelModuleOff", value: true });
    await page.waitForFunction(() => /^\s*Done/.test(document.querySelector("#check-duel").textContent)); // after the reload
    overlays = 1;
    seen = { ...seen, accept: now };
    await page.waitForFunction(
      () => document.querySelector("#check-title").textContent === "Stream setup is done",
      null,
      { timeout: 15000 },
    );
    assert.match(await page.locator("#check-overlay").textContent(), /1 overlay is connected right now/);
    assert.equal(await page.locator("#setup-next").isHidden(), true);
    // check-in test mode: on for 15 minutes, then off again
    assert.equal(await page.locator("#checkin-test-title").textContent(), "Test !checkin while offline");
    await page.click("#checkin-test-toggle");
    await page.waitForFunction(
      () => document.querySelector("#checkin-test-title").textContent === "!checkin test mode is on",
    );
    assert.deepEqual(posts.at(-1), { action: "checkinTest", value: true });
    assert.match(
      await page.locator("#checkin-test-text").textContent(),
      /^Until .+ \(turned on by ModMia\), !checkin answers while the stream is offline/,
    );
    assert.equal(await page.locator("#checkin-test-toggle").textContent(), "Turn test mode off");
    await noOverflow(page, "checkin test " + s.name);
    await page.locator("#checkin-test").screenshot({ path: shots + "/admin-checkin-test-" + s.name + ".png" });
    await page.click("#checkin-test-toggle");
    await page.waitForFunction(
      () => document.querySelector("#checkin-test-title").textContent === "Test !checkin while offline",
    );
    assert.deepEqual(posts.at(-1), { action: "checkinTest", value: false });
    await context.close();
  }
  // 7a. Chat commands: shown while the PixFray bot reads chat; add, edit, delete and set a counter.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    const posts = [];
    let data = {
      commands: [
        { name: "!nt", reply: "Nesszerra has tried $(count nt) times!" },
        { name: "!tablet", reply: "60Wx45H (CTL-472 700hz custom firmware)" },
      ],
      counters: [{ name: "nt", value: 1 }],
      max: 50,
    };
    const chatStatus = {
      connected: true,
      source: "twitch",
      status: "enabled",
      subscriptionId: "sub-bot",
      createdAt: now - 86400000,
      lastNotificationAt: now - 120000,
      lastRevocationReason: "",
      checkedAt: now,
    };
    await page.route("**/api/session", (r) =>
      json(r, { user: mod, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: true, canManage: true }));
    await page.route("**/api/leaderboard/nesszerra*", (r) => json(r, board));
    await page.route("**/api/assets/nesszerra", (r) =>
      json(r, {
        items: [],
        usage: { count: 0, limit: 8, bytes: 0 },
        limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
      }),
    );
    await page.route("**/api/admin/nesszerra", (r) => {
      if (r.request().method() === "POST") {
        const body = r.request().postDataJSON();
        posts.push(body);
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
      }
      return json(r, {
        type: "snapshot",
        channel: "nesszerra",
        revision: 5,
        paused: false,
        chat: { connected: true, lastSeen: now, status: "enabled" },
        config,
        configVersion: 1,
        round: 1,
        players: [],
        duels: [],
        events: [],
        chatStatus,
        history: [{ version: 1, config, actorId: "system", at: now - 86400000, note: "" }],
        customUsage: { count: 0, limit: 8, bytes: 0 },
        streamelements: {
          key: "k".repeat(48),
          names: {},
          origin: base,
          lastCommandAt: 0,
          rejectedAt: 0,
          seen: {},
          duelModuleOff: true,
          timerText: "x",
          commands: [],
        },
        overlays: 1,
        modsReady: true,
        checkinTestAllowed: true,
        chatBot: { login: "pixfray", debug: false },
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
        access: { owner: false, moderator: true, canManage: true },
      });
    });
    await page.goto(base + "/admin/");
    await page.click("#tab-chat");
    await page.waitForSelector("#bot-commands:not([hidden])");
    // a bot site: the bot step replaces the StreamElements steps, Done while the bot reads chat
    assert.equal(await page.locator("#check-bot [data-badge]").textContent(), "Done");
    assert.match(
      await page.locator("#check-bot [data-detail]").textContent(),
      /^The PixFray bot \(pixfray\) reads your chat and answers the duel commands\. It last answered a command \d+ (s|min) ago\. Type \/mod pixfray/,
    );
    for (const id of ["#check-duel", "#check-commands"])
      assert.equal(await page.locator(id).isHidden(), true, id + " hidden on a bot site");
    assert.equal(await page.locator("#check-title").textContent(), "Stream setup is done");
    assert.deepEqual(await page.locator("#bot-commands-table tbody td:first-child").allTextContents(), [
      "!nt",
      "!tablet",
    ]);
    // the bot's health: a drop newer than the last sent reply is a warning
    assert.match(
      await page.locator("#bot-health").textContent(),
      /^Bot: last command \d+ (s|min) ago \(alice !fray\), last reply sent \d+ (s|min) ago\. 41 sent, 1 dropped\. The last reply was dropped \d+ (s|min) ago: the same line twice within 30 s \(msg_duplicate\)\. Type !fray debug/,
    );
    assert.equal(await page.locator("#bot-health").getAttribute("class"), "small callout warning");
    assert.equal(await page.locator('[data-counter="nt"]').inputValue(), "1");
    // add (a PixFray name is refused with a reason), edit with a rename, set a counter, delete
    await page.fill("#command-name", "fray");
    await page.fill("#command-reply", "x");
    await page.click("#command-save");
    await page.waitForFunction(() =>
      /PixFray already uses that name/.test(document.querySelector("#command-status").textContent),
    );
    await page.fill("#command-name", "Sens");
    await page.fill("#command-reply", "0.14 3600dpi");
    await page.click("#command-save");
    await page.waitForFunction(() => /Added !sens/.test(document.querySelector("#command-status").textContent));
    assert.deepEqual(posts.at(-1), { action: "saveCommand", payload: { name: "!sens", reply: "0.14 3600dpi" } });
    assert.equal(await page.locator("#command-name").inputValue(), "");
    await page.click('[data-edit="!tablet"]');
    assert.equal(await page.locator("#command-save").textContent(), "Save changes");
    await page.fill("#command-name", "!pad");
    await page.click("#command-save");
    await page.waitForFunction(() => /Saved !pad/.test(document.querySelector("#command-status").textContent));
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
    await page.waitForFunction(() =>
      /Counter nt is 20 now/.test(document.querySelector("#counter-status").textContent),
    );
    assert.deepEqual(posts.at(-1), { action: "setCounter", payload: { name: "nt", value: 20 } });
    await noOverflow(page, "chat commands " + s.name);
    for (const id of ["#bot-commands-table", "#bot-counters-table"])
      assert.ok(
        await page
          .locator(id)
          .locator("xpath=..")
          .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        id + " does not scroll sideways at " + s.name,
      );
    await page.locator("#bot-commands").screenshot({ path: shots + "/admin-bot-commands-" + s.name + ".png" });
    page.once("dialog", (d) => d.accept());
    await page.click('[data-delete="!sens"]');
    await page.waitForFunction(() => /Deleted !sens/.test(document.querySelector("#command-status").textContent));
    assert.deepEqual(posts.at(-1), { action: "deleteCommand", payload: { name: "!sens" } });
    await context.close();
  }
  // 7b. Step 4 "Let your moderators help" reads differently for the broadcaster, the site owner on another channel, and a moderator.
  {
    const owner = { id: "9009", login: "nesszerra", displayName: "nesszerra" },
      newstreamer = { id: "5505", login: "newstreamer", displayName: "NewStreamer" };
    const ownerAccess = { owner: true, moderator: false, canManage: true },
      broadcasterAccess = { owner: false, broadcaster: true, moderator: false, canManage: true };
    const reconnect = "/auth/login?channel=newstreamer&connect=mods";
    const cases = [
      {
        name: "owner, not connected",
        channel: "miolafff",
        session: owner,
        owner: true,
        access: ownerAccess,
        extra: { modsReady: false },
        text: /^Mod access isn't connected\. miolafff has to connect it from their own Stream setup page\.$/,
        badge: "Optional",
        link: null,
      },
      {
        name: "owner, connected",
        channel: "miolafff",
        session: owner,
        owner: true,
        access: ownerAccess,
        extra: { modsReady: true },
        text: /^Twitch moderators of miolafff can sign in and use this page\.$/,
        badge: "Done",
        link: null,
      },
      {
        name: "owner, expired",
        channel: "miolafff",
        session: owner,
        owner: true,
        access: ownerAccess,
        extra: { modsReady: false, modsLapsed: true },
        text: /^Mod access expired\. miolafff has to reconnect it from their own Stream setup page\.$/,
        badge: "Expired",
        link: null,
      },
      {
        name: "broadcaster, not connected",
        channel: "newstreamer",
        session: newstreamer,
        owner: false,
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
        owner: false,
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
        owner: false,
        access: { owner: false, moderator: true, canManage: true },
        extra: { modsReady: false },
        paused: true,
        text: /^Mod access isn't connected\. Ask miolafff to connect it\.$/,
        badge: "Optional",
        link: null,
      },
    ];
    for (const c of cases)
      for (const s of sizes) {
        const { context, page } = await newPage(s);
        const ch = c.channel;
        await page.route("**/api/session", (r) =>
          json(r, {
            user: c.session,
            owner: c.owner,
            configured: true,
            channels: ["nesszerra"],
            productionEnabled: false,
          }),
        );
        await page.route("**/api/access/" + ch, (r) => json(r, c.access));
        await page.route("**/api/leaderboard/" + ch + "*", (r) => json(r, []));
        await page.route("**/api/assets/" + ch, (r) =>
          json(r, {
            items: [],
            usage: { count: 0, limit: 8, bytes: 0 },
            limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
          }),
        );
        await page.route("**/api/admin/" + ch, (r) =>
          json(r, {
            type: "snapshot",
            channel: ch,
            revision: 1,
            paused: false,
            chat: { connected: false, lastSeen: 0, status: "disconnected" },
            config: { ...config, enabled: !c.paused },
            configVersion: 1,
            round: 1,
            players: [],
            duels: [],
            events: [],
            chatStatus: { connected: false, status: "disconnected", subscriptionId: "", createdAt: 0 },
            history: [{ version: 1, config, actorId: "system", at: now, note: "" }],
            customUsage: { count: 0, limit: 8, bytes: 0 },
            streamelements: null,
            overlays: 0,
            channelState: "on",
            ...c.extra,
            access: c.access,
          }),
        );
        await page.goto(base + "/admin/?channel=" + ch + "#chat");
        await page.waitForSelector("#app:not([hidden])");
        await page.waitForFunction(() => document.querySelector("#check-mods [data-detail]").textContent.length > 0);
        const detail = (await page.locator("#check-mods [data-detail]").textContent()).trim();
        assert.match(detail, c.text, c.name + " " + s.name);
        assert.ok(!/Only \w+ can open this page/.test(detail), c.name + ": the old wording is gone");
        assert.equal(await page.locator("#check-mods [data-badge]").textContent(), c.badge, c.name + " badge");
        if (c.link) {
          assert.equal(await page.locator("#check-mods a").textContent(), c.link[0]);
          assert.equal(await page.locator("#check-mods a").getAttribute("href"), c.link[1]);
        } else
          assert.equal(await page.locator("#check-mods a").count(), 0, c.name + ": no connect link for this viewer");
        if (c.paused) {
          await page.click("#tab-live");
          assert.match(await page.locator("#stats").textContent(), /Duels\s*Paused\s*commands ignored/);
        }
        if (s.name === "1280" && /owner, not/.test(c.name))
          await page.locator("#check-mods").screenshot({ path: shots + "/admin-step4-owner-1280.png" });
        await context.close();
      }
  }
  // 7c. The bot step for a signed-up channel: the broadcaster gets Add the PixFray bot (the one primary button while it's
  // next), coming back with bot=allowed connects chat by itself, and a mod is told to ask the broadcaster.
  {
    const newstreamer = { id: "5505", login: "newstreamer", displayName: "NewStreamer" },
      ch = "newstreamer";
    const cases = [
      {
        name: "broadcaster",
        session: newstreamer,
        access: { owner: false, broadcaster: true, moderator: false, canManage: true },
        query: "",
      },
      {
        name: "broadcaster back with bot=allowed",
        session: newstreamer,
        access: { owner: false, broadcaster: true, moderator: false, canManage: true },
        query: "&bot=allowed",
      },
      { name: "moderator", session: mod, access: { owner: false, moderator: true, canManage: true }, query: "" },
    ];
    for (const c of cases)
      for (const s of sizes) {
        const { context, page } = await newPage(s);
        const posts = [];
        let chatStatus = { connected: false, status: "disconnected", subscriptionId: "", createdAt: 0 };
        await page.route("**/api/session", (r) =>
          json(r, {
            user: c.session,
            owner: false,
            configured: true,
            channels: ["nesszerra"],
            productionEnabled: false,
          }),
        );
        await page.route("**/api/access/" + ch, (r) => json(r, c.access));
        await page.route("**/api/leaderboard/" + ch + "*", (r) => json(r, []));
        await page.route("**/api/assets/" + ch, (r) =>
          json(r, {
            items: [],
            usage: { count: 0, limit: 8, bytes: 0 },
            limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
          }),
        );
        await page.route("**/api/admin/" + ch, (r) => {
          if (r.request().method() === "POST") {
            posts.push(r.request().postDataJSON());
            chatStatus = {
              connected: true,
              source: "twitch",
              status: "enabled",
              subscriptionId: "sub-bot",
              createdAt: now,
            };
            return json(r, { ok: true, chatStatus });
          }
          return json(r, {
            type: "snapshot",
            channel: ch,
            revision: 1,
            paused: false,
            chat: { connected: chatStatus.connected, lastSeen: 0, status: chatStatus.status },
            config,
            configVersion: 1,
            round: 1,
            players: [],
            duels: [],
            events: [],
            chatStatus,
            history: [{ version: 1, config, actorId: "system", at: now, note: "" }],
            customUsage: { count: 0, limit: 8, bytes: 0 },
            streamelements: {
              key: "k".repeat(48),
              names: {},
              origin: base,
              lastCommandAt: 0,
              rejectedAt: 0,
              seen: {},
              duelModuleOff: false,
              timerText: "x",
              commands: [],
            },
            overlays: 1,
            modsReady: true,
            channelState: "on",
            chatBot: { login: "pixfray", debug: false },
            botCommands: { commands: [], counters: [], max: 50 },
            botStatus: null,
            access: c.access,
          });
        });
        await page.goto(base + "/admin/?channel=" + ch + c.query + "#chat");
        await page.waitForSelector("#app:not([hidden])");
        await page.waitForFunction(() => document.querySelector("#check-bot [data-detail]").textContent.length > 0);
        for (const id of ["#check-duel", "#check-commands"])
          assert.equal(await page.locator(id).isHidden(), true, c.name + ": " + id + " hidden");
        assert.equal(
          await page.locator("#chat-box").isHidden(),
          false,
          c.name + ": the chat connection shows on a signed-up channel",
        );
        if (c.query) {
          await page.waitForFunction(() => document.querySelector("#check-bot [data-badge]").textContent === "Done");
          assert.deepEqual(posts, [{ action: "connectChat" }], "bot=allowed connects chat once");
          assert.equal(new URL(page.url()).searchParams.get("bot"), null, "the flag leaves the address");
          assert.match(await page.locator("#bot-status").textContent(), /Chat connected/);
          assert.equal(await page.locator("#check-title").textContent(), "Stream setup is done");
          assert.equal(
            await page.locator("#copy").getAttribute("class"),
            "btn btn-primary",
            "Copy link is primary again",
          );
        } else if (c.access.broadcaster) {
          assert.equal(await page.locator("#check-bot [data-badge]").textContent(), "To do");
          assert.equal(await page.locator("#check-title").textContent(), "Stream setup: 1 of 2 steps done");
          const add = page.locator("#bot-actions a");
          assert.equal(await add.textContent(), "Add the PixFray bot");
          assert.equal(await add.getAttribute("href"), "/auth/login?channel=newstreamer&connect=bot");
          assert.equal(await page.locator("#panel-chat .btn-primary").count(), 1, "one primary button");
          assert.equal(await add.getAttribute("class"), "btn btn-primary");
          assert.match(await page.locator("#setup-next").textContent(), /Next: add the PixFray bot to your chat\./);
          await noOverflow(page, "bot step " + s.name);
          await page.locator("#check-bot").screenshot({ path: shots + "/admin-bot-step-" + s.name + ".png" });
        } else {
          assert.match(
            await page.locator("#check-bot [data-detail]").textContent(),
            /^Ask newstreamer to open this page and click Add the PixFray bot, or to type \/mod pixfray/,
          );
          await page.click("#bot-actions button");
          await page.waitForFunction(() => document.querySelector("#check-bot [data-badge]").textContent === "Done");
          assert.deepEqual(posts, [{ action: "connectChat" }]);
        }
        await context.close();
      }
  }
  // 8. /start: open sign-up, and each reason Twitch sign-in can send someone back, at 1280/390.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    await page.goto(base + "/start/");
    assert.equal(await page.locator("#signup-title").textContent(), "Sign in with the Twitch account you stream on");
    assert.equal(await page.locator("#signup-actions a.btn-primary").getAttribute("href"), "/auth/login?signup=1");
    assert.equal(await page.locator("#signup-actions a").count(), 1);
    assert.equal(
      await page.locator("#ready-actions a.btn-primary").getAttribute("href"),
      "/auth/login?signup=1",
      "the closing band repeats the sign-in",
    );
    assert.equal(await page.locator("#signup-problem").isHidden(), true);
    assert.match(await page.locator("#source a").getAttribute("href"), /^https:\/\/github\.com\//);
    const stage = await page.locator(".stage").boundingBox(),
      frame = await page.locator(".stage iframe").boundingBox();
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
      await page.locator(".stage iframe").evaluate((f) => f.offsetWidth >= 640),
      "overlay lays out at 640px or wider",
    );
    await page.waitForTimeout(5000); // let the demo fighters walk in before the screenshot
    await noOverflow(page, "start valid " + s.name);
    await page.screenshot({ path: shots + "/start-valid-" + s.name + ".png", fullPage: true });
    // back from Twitch after cancelling the permission: offer setup without mod access, and drop ?error from the URL
    await page.goto(base + "/start/?error=denied");
    await page.waitForSelector("#signup-problem:not([hidden])");
    assert.match(await page.locator("#signup-problem").textContent(), /cancelled the Twitch permission/);
    assert.deepEqual(await page.locator("#signup-actions a").evaluateAll((a) => a.map((x) => x.getAttribute("href"))), [
      "/auth/login?signup=1",
      "/auth/login?signup=1&mods=0",
    ]);
    assert.equal(new URL(page.url()).search, "");
    if (s.name === "390") await page.locator("#signup").screenshot({ path: shots + "/start-denied-390.png" });
    await page.goto(base + "/start/?error=full");
    await page.waitForSelector("#signup-problem:not([hidden])");
    assert.match(await page.locator("#signup-problem").textContent(), /PixFray is full right now/);
    await page.goto(base + "/start/?error=failed");
    await page.waitForSelector("#signup-problem:not([hidden])");
    assert.match(await page.locator("#signup-problem").textContent(), /sign-in didn't finish/);
    await page.goto(base + "/start/?invite=" + "ab".repeat(16));
    assert.equal(await page.locator("#signup-problem").isHidden(), true, "an old invite link opens the plain sign-up");
    await context.close();
  }

  // 9. A signed-up channel's own admin page: connect mod access later, turn PixFray off and back on.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    const me = { id: "5505", login: "newstreamer", displayName: "NewStreamer" };
    let channelState = "on";
    const posts = [];
    await page.route("**/api/session", (r) =>
      json(r, { user: me, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/newstreamer", (r) =>
      json(r, { owner: false, broadcaster: true, moderator: false, canManage: true }),
    );
    await page.route("**/api/leaderboard/newstreamer", (r) => json(r, []));
    await page.route("**/api/assets/newstreamer", (r) =>
      json(r, {
        items: [],
        usage: { count: 0, limit: 8, bytes: 0 },
        limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 },
      }),
    );
    await page.route("**/api/admin/newstreamer", (r) => {
      if (r.request().method() === "POST") {
        const body = r.request().postDataJSON();
        posts.push(body);
        channelState = body.action === "pauseChannel" ? "paused" : "on";
        return json(r, { ok: true, channelState });
      }
      return json(r, {
        type: "snapshot",
        channel: "newstreamer",
        revision: 1,
        paused: false,
        chat: { connected: false, lastSeen: 0, status: "disconnected" },
        config,
        configVersion: 1,
        round: 1,
        players: [],
        duels: [],
        events: [],
        chatStatus: { connected: false, status: "disconnected", subscriptionId: "", createdAt: 0 },
        history: [{ version: 1, config, actorId: "system", at: now, note: "" }],
        customUsage: { count: 0, limit: 8, bytes: 0 },
        streamelements: null,
        overlays: 0,
        modsReady: false,
        channelState,
        access: { owner: false, broadcaster: true, moderator: false, canManage: true },
      });
    });
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/admin/?channel=newstreamer&mods=denied#chat");
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForFunction(() =>
      /permission was cancelled/.test(document.querySelector("#check-status").textContent),
    );
    assert.equal(new URL(page.url()).search, "?channel=newstreamer", "the mods flag is dropped from the URL");
    assert.equal(
      await page.locator("#check-mods a").getAttribute("href"),
      "/auth/login?channel=newstreamer&connect=mods",
    );
    assert.equal(await page.locator("#chat-box").isHidden(), true, "Twitch chat connection is for nesszerra only");
    assert.equal(await page.locator("#troubleshoot").isVisible(), true);
    assert.deepEqual(await page.locator("#checklist > li:not([hidden]) h3").allTextContents(), [
      "Add the overlay to OBS",
      "Turn off the StreamElements Duel module",
      "Add the chat commands to StreamElements",
      "Let your moderators help",
    ]);
    assert.equal(await page.locator("#summary-title").textContent(), "Waiting for chat");
    assert.match(await page.locator("#stats").textContent(), /Duels\s*Waiting\s*for chat/);
    assert.equal(await page.locator("#channel-power").isVisible(), true);
    assert.equal(await page.locator("#paused-note").isHidden(), true);
    await page.click("#power-toggle");
    await page.waitForSelector("#paused-note:not([hidden])");
    assert.deepEqual(posts.at(-1), { action: "pauseChannel" });
    assert.equal(await page.locator("#power-title").textContent(), "PixFray is off on newstreamer");
    assert.equal(await page.locator("#power-toggle").textContent(), "Turn PixFray back on");
    await noOverflow(page, "admin paused " + s.name);
    await page.screenshot({ path: shots + "/admin-paused-" + s.name + ".png" });
    await page.locator("#channel-power").screenshot({ path: shots + "/admin-power-" + s.name + ".png" });
    await page.click("#power-toggle");
    await page.waitForSelector("#paused-note", { state: "hidden" });
    assert.deepEqual(posts.at(-1), { action: "resumeChannel" });
    await context.close();
  }

  // 10. The viewer page of a channel that is off, or was never set up.
  {
    const { context, page } = await newPage(sizes[1]);
    let off = "paused";
    await page.route("**/api/state/*", (r) => json(r, { error: "off", off }, 403));
    await page.goto(base + "/?channel=newstreamer");
    await page.waitForSelector("#off-note:not([hidden])");
    assert.match(await page.locator("#off-note").textContent(), /PixFray is off on newstreamer's channel right now/);
    assert.equal(await page.locator(".fighter-card").isVisible(), true);
    off = "not_enabled";
    await page.goto(base + "/?channel=nobodyhere");
    await page.waitForSelector("#off-note:not([hidden])");
    assert.match(await page.locator("#off-note").textContent(), /isn't set up on nobodyhere's channel/);
    assert.equal(await page.locator(".fighter-card").isHidden(), true);
    await noOverflow(page, "viewer not set up 390");
    await page.screenshot({ path: shots + "/viewer-not-set-up-390.png" });
    await context.close();
  }
  // 11. Builds: looking at another saved build is not an unsaved edit; leaving warns only after a real change.
  // 12. A paused channel: the signed-in viewer sees their fighter; saving and buying say they're closed.
  for (const paused of [false, true]) {
    const { context, page } = await newPage(sizes[0]);
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
    const profile = {
      ...board[1],
      ...look,
      avatar: "player",
      hp: 100,
      registered: true,
      respawnAt: 0,
      lastSeen: now,
      bonus: 0,
      dollars: 500,
      build: 0,
      owned: { pets: [], hats: [], slots: 2 },
      builds: [
        { ...look, avatar: "player" },
        { ...look, avatar: "adventurer", color: "#34d399" },
      ],
    };
    await page.route("**/api/session", (r) =>
      json(r, { user, owner: false, configured: true, channels: ["nesszerra"], productionEnabled: false }),
    );
    await page.route("**/api/access/nesszerra", (r) => json(r, { owner: false, moderator: false, canManage: false }));
    await page.route("**/api/profile/nesszerra", (r) => json(r, profile));
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
      assert.match(await page.locator("#save-status").textContent(), /Build 2 isn't on stream/);
      assert.equal(await leaving(), false, "only looking at build 2");
      await page.locator('.swatch[data-color="#f472b6"]').click();
      assert.equal(await leaving(), true, "build 2 was changed");
      await page.locator("#build-list button.build").nth(0).click();
      assert.equal(await leaving(), true, "the edit in build 2 is still unsaved");
    } else {
      await page.waitForSelector("#off-note:not([hidden])");
      assert.equal(await page.locator("#save").isDisabled(), true);
      assert.match(
        await page.locator("#save-status").textContent(),
        /PixFray is off on this channel right now, so saving and buying are closed. Your fighter is kept./,
      );
      assert.equal(await page.locator("#next-step").isHidden(), true);
      await page.locator("#tab-shop").click();
      await page.locator('.jump a[href="#shop-title"]').click();
      assert.equal(
        await page.getByRole("button", { name: "Buy Iron Wall title for $15" }).isDisabled(),
        true,
        "buying is closed",
      );
      await noOverflow(page, "viewer paused signed-in");
      await page.screenshot({ path: shots + "/viewer-paused-signed-in-1280.png" });
    }
    await context.close();
  }
  // /start: the sign-in line sits below the copy (beside the demo on wide screens), never over it.
  for (const size of sizes) {
    const { context, page } = await newPage({ width: size.width, height: size.height });
    await page.goto(base + "/start/");
    await page.waitForFunction(() => document.querySelector("#signup-text")?.textContent.trim());
    const copy = await page.locator(".hero-copy").boundingBox(),
      card = await page.locator("#signup").boundingBox();
    const apart = card.x >= copy.x + copy.width || card.y >= copy.y + copy.height;
    assert.ok(apart, `start ${size.name}: sign-in card overlaps the copy`);
    assert.ok(copy.width >= Math.min(size.width * 0.5, 400), `start ${size.name}: copy squeezed to ${copy.width}px`);
    await noOverflow(page, "start " + size.name);
    await context.close();
  }
  // The intro (the home page; /intro/ moves there): the loader finishes (WebGL or the text-only fallback), the headline
  // shows and nothing overflows while scrolling. A first visit offers the picker.
  for (const size of sizes) {
    const { context, page } = await newPage({ width: size.width, height: size.height });
    await page.route("**/api/leaderboard/**", (r) => json(r, board));
    await page.goto(base + "/intro/");
    assert.equal(new URL(page.url()).pathname, "/", "the old /intro/ address moves to the home page");
    assert.equal(await page.locator("#hero-actions .btn").getAttribute("href"), "/play/");
    await page.waitForFunction(() => document.querySelector("#loader")?.classList.contains("is-done"), null, {
      timeout: 30000,
    });
    assert.ok(await page.locator("h1").isVisible(), `intro ${size.name}: headline hidden`);
    for (const y of [0, 0.5, 1]) {
      await page.evaluate((f) => scrollTo(0, f * (document.documentElement.scrollHeight - innerHeight)), y);
      await page.waitForTimeout(300);
      await noOverflow(page, `intro ${size.name} at ${y}`);
    }
    await context.close();
  }
  // a browser without WebGL2 gets the text-only page and this one deliberate error
  // (in dev, Vite's client also logs when it can't forward that error to the server)
  for (let i = errors.length - 1; i >= 0; i--)
    if (/WebGL2 is not available|Failed to send error to Vite server/.test(errors[i])) errors.splice(i, 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: viewer + admin UI at 1280/390, signed-out (real server), signed-in viewer save, mod gate, admin actions, config save/409/revert; no page errors.",
  );
} finally {
  await browser.close();
}
