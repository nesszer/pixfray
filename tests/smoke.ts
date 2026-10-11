import { chromeOptions } from "./chrome.ts";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { enforceCsp } from "./csp-helper.ts";
// The fake socket the init script below puts in place of WebSocket, as the page and the test read it.
type FakeSocket = {
  readyState: number;
  sent: string[];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  close(): void;
};
// The init script's test hooks on window, which lib.dom doesn't know.
type MockWindow = { __sockets: FakeSocket[]; __irc(data: string): void };
// Page callbacks below run in the overlay, where the init script adds them.
declare const window: Window & typeof globalThis & MockWindow;
const browser = await chromium.launch(chromeOptions());
const base = process.env.MINI_BASE_URL || "http://127.0.0.1:5173";
const out = fileURLToPath(new URL("../screenshots", import.meta.url));
fs.mkdirSync(out, { recursive: true });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await enforceCsp(page);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply|connect|create)/.test(m.text()))
      errors.push("CSP: " + m.text());
  });
  await page.goto(base);
  assert.match(await page.title(), /PixFray/);
  await page.screenshot({ path: out + "/setup-preview.png", fullPage: true });
  await page.goto(base + "/overlay.html?demo=1&debug=1&cap=50&size=64");
  // !: the overlay page always has #status, and an element's textContent is a string, never null
  await page.waitForFunction(() => document.querySelector("#status")!.textContent!.includes("8/50"));
  await page.waitForTimeout(700);
  const pixels = await page.evaluate(() => {
    // !: the overlay page always has the #stage canvas, and a canvas always gives a 2d context here
    const c = document.querySelector<HTMLCanvasElement>("#stage")!,
      ctx = c.getContext("2d")!; // !: a canvas gives a 2d context
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let bottom = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) bottom++;
    return { top: ctx.getImageData(20, 20, 1, 1).data[3], painted: bottom };
  });
  assert.equal(pixels.top, 0);
  assert.ok(pixels.painted > 1000);
  await page.screenshot({ path: out + "/overlay-preview.png", omitBackground: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#stage").evaluate((c: HTMLCanvasElement) => c.width), 390);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await enforceCsp(context);
  await context.addInitScript(() => {
    window.__sockets = [];
    class FakeWS {
      declare readyState: number;
      declare sent: string[];
      declare onopen?: () => void;
      declare onclose?: () => void;
      constructor() {
        this.readyState = 1;
        this.sent = [];
        window.__sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      send(m: string) {
        this.sent.push(m);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    // as typeof WebSocket: the fake has only the members the overlay's chat client uses
    window.WebSocket = FakeWS as unknown as typeof WebSocket;
    // !: __irc is called only after the waits below saw a socket
    window.__irc = (data) => window.__sockets.at(-1)!.onmessage?.({ data });
  });
  const mock = await context.newPage();
  mock.on("pageerror", (e) => errors.push(e.message));
  mock.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply|connect|create)/.test(m.text()))
      errors.push("CSP: " + m.text());
  });
  await mock.goto(base + "/overlay.html?debug=1&cap=2");
  await mock.waitForFunction(() => window.__sockets.length > 0);
  await mock.evaluate(() => window.__irc(":tmi.twitch.tv 366 anon #nesszerra :End of /NAMES list\r\n"));
  const message = (id: string, user: string, text: string) =>
    "@id=" +
    id +
    ";user-id=" +
    user +
    ";display-name=" +
    user +
    ";color=#aabbcc :" +
    user +
    "!" +
    user +
    "@" +
    user +
    ".tmi.twitch.tv PRIVMSG #nesszerra :" +
    text +
    "\r\n";
  await mock.evaluate((m) => window.__irc(m), message("a", "alice", "!avatar soldier"));
  // !: #status and its text, as above
  await mock.waitForFunction(() => document.querySelector("#status")!.textContent!.includes("1/2"));
  await mock.evaluate((m) => window.__irc(m), message("b", "alice", "!color #ff8844"));
  // !: the !avatar and !color commands above saved the cosmetics key
  const prefs = await mock.evaluate(() => JSON.parse(localStorage.getItem("mini-chat:cosmetics:nesszerra")!));
  assert.equal(prefs.alice.avatar, "soldier");
  assert.equal(prefs.alice.color, "#ff8844");
  await mock.evaluate((m) => window.__irc(m), message("c", "bob", "hello") + message("d", "charlie", "hello"));
  // !: #status exists, so its textContent is a string
  assert.match((await mock.locator("#status").textContent())!, /2\/2/);
  await mock.evaluate(() => window.__irc("@target-user-id=bob :tmi.twitch.tv CLEARCHAT #nesszerra :bob\r\n"));
  // !: #status exists, so its textContent is a string
  assert.match((await mock.locator("#status").textContent())!, /1\/2/);
  await mock.reload();
  await mock.waitForFunction(() => window.__sockets.length > 0);
  assert.equal(
    // !: the cosmetics key survives the reload, as above
    await mock.evaluate(() => JSON.parse(localStorage.getItem("mini-chat:cosmetics:nesszerra")!).alice.avatar),
    "soldier",
  );
  await mock.evaluate((m) => window.__irc(m), message("e", "alice", "!jump"));
  // !: #status and its text, as above
  await mock.waitForFunction(() => document.querySelector("#status")!.textContent!.includes("1/2"));
  await mock.evaluate(() => window.__irc(":tmi.twitch.tv CLEARCHAT #nesszerra\r\n"));
  // !: #status exists, so its textContent is a string
  assert.match((await mock.locator("#status").textContent())!, /0\/2/);
  // !: the socket the overlay opened, waited for above
  await mock.evaluate(() => window.__sockets.at(-1)!.close());
  // !: #status and its text, as above
  await mock.waitForFunction(() => document.querySelector("#status")!.textContent!.includes("reconnecting"));
  await mock.waitForFunction(() => window.__sockets.length === 2, {}, { timeout: 5000 });
  await mock.close();
  await context.close();
  const live = await browser.newPage();
  await enforceCsp(live);
  live.on("pageerror", (e) => errors.push(e.message));
  live.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply|connect|create)/.test(m.text()))
      errors.push("CSP: " + m.text());
  });
  await live.goto(base + "/overlay.html?channel=nesszerra&debug=1");
  await live.waitForFunction(
    // !: #status and its text, as above
    () => document.querySelector("#status")!.textContent!.includes("connected"),
    {},
    { timeout: 15000 },
  );
  console.log("LIVE_BROWSER", await live.locator("#status").textContent());
  await live.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: setup URL, transparent sprite rendering, resize, commands/preferences, cap, moderation, reload, reconnect, real Twitch join; no page errors.",
  );
} finally {
  await browser.close();
}
