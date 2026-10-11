import assert from "node:assert/strict";
import test from "node:test";
import { URL as NodeURL } from "node:url";
import site from "../site.config.js";
import { CHANNELS } from "../server/auth.ts";

test("site config keeps the deployment defaults and built-in channel identity", () => {
  assert.deepEqual(site, {
    owner: { login: "nesszerra", twitchId: "445610108" },
    builtinChannels: ["nesszerra", "miolafff"],
    defaultChannel: "nesszerra",
    workers: { production: "nesszerra-mini-chat", test: "nesszerra-mini-chat-test" },
    origins: { production: "https://pixfray.xyz", test: "https://staging.pixfray.xyz" },
    channelDomains: { production: {}, test: {} },
    bot: { production: "pixfray", test: "pixfray" },
  });
  assert.strictEqual(CHANNELS, site.builtinChannels);
});

// A copy of PixFray changes only site.config.js: pages and browser scripts name the site through %SITE_*% tokens
// (vite.config.ts) or read it at run time, never the original owner, channels or domains.
test("pages and browser scripts carry no hard-coded owner, channel or domain", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "index.html",
    "admin/index.html",
    "admin/dev/index.html",
    "start/index.html",
    "intro/index.html",
    "public/overlay.html",
    "src/served/overlay.ts",
    "src/served/upload.ts",
    "src/dev.ts",
    "src/ui.ts",
    "src/admin.ts",
    "src/dashboard.ts",
    "src/setup.ts",
    "src/start.ts",
    "src/intro/main.ts",
  ];
  const words = [
    site.owner.login,
    site.owner.twitchId,
    ...site.builtinChannels,
    ...Object.values(site.origins).map((o) => new URL(o).host),
  ];
  for (const file of files) {
    const text = readFileSync(new NodeURL("../" + file, import.meta.url), "utf8");
    for (const word of words) assert.ok(!text.includes(word), `${file} names ${word}`);
  }
});
