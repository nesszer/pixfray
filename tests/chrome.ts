// Every browser test runs in headed Chrome with WebGL on the GPU, and never takes focus from the window the owner is
// using: Chrome starts without a window, each page opens as a background window on the second monitor (BROWSER_POS="x,y"
// moves it) through CDP, and Playwright drives it over connectOverCDP. --hide-scrollbars keeps widths like a phone's
// overlay scrollbars. HEADLESS=1 hides it.
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [left = -3400, top = -1000] = (process.env.BROWSER_POS || "").split(",").filter(Boolean).map(Number);

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

// Opens a page of `context` as a background window. Playwright attaches to the new target and reports it as the
// context's page, with the context's viewport, routes and cookies applied.
async function backgroundPage(cdp: CDPSession, context: BrowserContext, browserContextId: string) {
  const page = context.waitForEvent("page");
  await cdp.send("Target.createTarget", {
    url: "about:blank",
    browserContextId,
    newWindow: true,
    background: true,
    left,
    top,
    width: 1300,
    height: 950,
  });
  const p = await page;
  // a background window has no focus, so pages see focus as they would in the front window
  await (await context.newCDPSession(p)).send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return p;
}

// A Playwright Browser on a Chrome that never activates a window. newContext, context.newPage and browser.newPage open
// background windows; close() also ends the Chrome it started. The profile folder is per debugging port and reused.
export async function launchChrome(extra: string[] = []): Promise<Browser> {
  const port = await freePort();
  const profile = path.join(os.tmpdir(), "pixfray-test-chrome-" + port);
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    CHROME,
    [
      "--user-data-dir=" + profile,
      "--remote-debugging-port=" + port,
      "--no-startup-window",
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-gpu",
      "--use-angle=d3d11",
      "--ignore-gpu-blocklist",
      "--hide-scrollbars",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      ...(process.env.HEADLESS === "1" ? ["--headless=new"] : []),
      ...extra,
    ],
    { stdio: "ignore" },
  );
  const stop = () => child.kill();
  process.on("exit", stop);
  let connected: Browser | null = null;
  for (let i = 0; i < 80 && !connected; i++)
    connected = await chromium.connectOverCDP("http://127.0.0.1:" + port).catch(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return null;
    });
  if (!connected) throw new Error("Chrome did not open its debugging port " + port);
  const browser = connected;
  const cdp = await browser.newBrowserCDPSession();
  const contextIds = async () => (await cdp.send("Target.getBrowserContexts")).browserContextIds;
  let queue = Promise.resolve();
  const newContext = browser.newContext.bind(browser);
  // The new context's CDP id is the one Target.getBrowserContexts gains; the queue keeps two creations from overlapping.
  browser.newContext = (options?: BrowserContextOptions) => {
    const made = queue.then(async () => {
      const before = new Set(await contextIds());
      const context = await newContext(options);
      const id = (await contextIds()).find((c) => !before.has(c));
      if (!id) throw new Error("the new browser context has no CDP id");
      context.newPage = () => backgroundPage(cdp, context, id);
      return context;
    });
    queue = made.then(
      () => {},
      () => {},
    );
    return made;
  };
  // like Playwright's browser.newPage: the page owns its context
  browser.newPage = async (options?: BrowserContextOptions) => {
    const context = await browser.newContext(options);
    const page: Page = await context.newPage();
    page.on("close", () => void context.close().catch(() => {}));
    return page;
  };
  const disconnect = browser.close.bind(browser);
  browser.close = async () => {
    await cdp.send("Browser.close").catch(() => {});
    await disconnect().catch(() => {});
    stop();
    process.off("exit", stop);
  };
  return browser;
}
