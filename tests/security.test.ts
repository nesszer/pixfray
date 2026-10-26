// Security headers, the trimmed public health check, and the per-user write limit (server/security.ts, server/ratelimit.ts).
// AuthStore runs for real on node:sqlite (the limit counts in it); rooms are a fake that echoes and records.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import worker from "../server/worker.ts";
import { hit, WRITE_LIMIT } from "../server/ratelimit.ts";
import { secure, PAGE_CSP, OVERLAY_CSP, API_CSP, HSTS } from "../server/security.ts";
import { forgetChannel } from "../server/channels.ts";
import { asEnv, must, type Loose } from "./fakes.ts";
import { ORIGIN, OWNER, VIEWER, SECRETS, namespace, sqliteAuth, signIn, req, call, status } from "./worker-fakes.ts";

const DEV_TOKEN = "d".repeat(40),
  OTHER = { id: "3", login: "other", displayName: "Other" };
/** AuthStore on SQLite behind a namespace that counts /hit calls; with `down`, /hit throws. */
function environment(extra: object = {}, down = false) {
  forgetChannel();
  const { store, ctx } = sqliteAuth(),
    rooms: { channel: string; path: string }[] = [],
    hits: number[] = [];
  const asset = (path: string) =>
    new Response(path.startsWith("/assets/characters") ? '[{"id":"player"}]' : "<!doctype html><title>page</title>", {
      headers: { "Content-Type": path.startsWith("/assets/") ? "application/json" : "text/html" },
    });
  const env = asEnv({
    ...SECRETS,
    OWNER_TWITCH_ID: "1",
    AUTH: namespace(async (_, url, init) => {
      if (new URL(url).pathname === "/hit") {
        if (down) throw new Error("down");
        hits.push(1);
      }
      return store.fetch(new Request(url, init));
    }),
    ROOMS: namespace(async (channel, url) => {
      const path = new URL(url).pathname;
      rooms.push({ channel, path });
      return Response.json(path === "/catalog" ? [] : { ok: true, path });
    }),
    ASSETS: { fetch: async (request: Request) => asset(new URL(request.url).pathname) },
    ...extra,
  });
  return { env, ctx, rooms, hits };
}
const profile = { avatar: "player", color: "#123456", defaultAbility: "strike" };

// ---------- headers ----------
test("script policy: scripts load from this origin only, with no hashes, inline allowance or eval", () => {
  for (const csp of [PAGE_CSP, OVERLAY_CSP]) {
    assert.match(
      csp,
      csp === PAGE_CSP
        ? /(^|; )script-src 'self' https:\/\/static\.cloudflareinsights\.com(;|$)/
        : /(^|; )script-src 'self'(;|$)/,
    ); // pages: Cloudflare Web Analytics
    assert.doesNotMatch(csp, /script-src[^;]*('unsafe-inline'|'unsafe-eval'|'wasm-unsafe-eval'|sha256-|nonce-)/);
    for (const rule of [/(^|; )object-src 'none'/, /(^|; )base-uri 'self'/, /img-src 'self' data: blob:/])
      assert.match(csp, rule);
  }
  assert.match(PAGE_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(
    OVERLAY_CSP,
    /frame-ancestors/,
    "the overlay stays frameable (the /start demo embeds it, OBS loads it directly)",
  );
  assert.match(OVERLAY_CSP, /connect-src 'self' wss:\/\/irc-ws\.chat\.twitch\.tv/);
  assert.match(API_CSP, /default-src 'none'/);
});

test("no page runs inline script, so script-src needs no hashes", () => {
  const pages = ["index.html", "admin/index.html", "admin/dev/index.html", "start/index.html", "changelog/index.html"];
  for (const file of [...pages, "intro/index.html", "public/overlay.html", "public/404.html"]) {
    const html = readFileSync(new NodeURL("../" + file, import.meta.url), "utf8");
    // both groups always take part in a match, so each entry holds two strings
    for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi) as unknown as Iterable<
      [string, string, string]
    >) {
      if (/\bsrc=/.test(attrs)) assert.equal(body.trim(), "", file + ": a script with src has no inline body");
      else
        assert.match(
          attrs,
          /type="application\/ld\+json"/,
          file + ": inline script that is not data: " + body.slice(0, 40),
        );
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, file + ": inline event handler");
    assert.doesNotMatch(html, /href=["']javascript:/i, file + ": javascript: URL");
  }
});

test("public/_headers repeats the Worker policies for pages assets serve without the Worker", () => {
  const rules: Record<string, Loose> = {}; // Loose: path -> header -> value, read by name below
  let at = "";
  for (const line of readFileSync(new NodeURL("../public/_headers", import.meta.url), "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      at = line.trim();
      rules[at] = {};
      continue;
    }
    const i = line.indexOf(":");
    rules[at][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  for (const path of ["/", "/admin/*", "/start/*", "/play/*", "/changelog/*"])
    assert.equal(rules[path]["content-security-policy"], PAGE_CSP, path);
  assert.equal(rules["/overlay*"]["content-security-policy"], OVERLAY_CSP);
  assert.match(
    rules["/overlay*"]["cache-control"],
    /(^|, )no-transform(,|$)/,
    "Cloudflare must not inject its analytics beacon into the overlay",
  );
  assert.equal(
    rules["/assets/build/*"]["cache-control"],
    "public, max-age=31536000, immutable",
    "hashed bundles are cached for a year",
  );
  assert.equal(rules["/*"]["strict-transport-security"], HSTS);
});

test("HSTS goes on every https response, a locked-down CSP on /api and /auth, the page CSP on pages", async () => {
  const { env } = environment();
  assert.equal(HSTS, "max-age=31536000; includeSubDomains");
  // [request, status (0: not checked), CSP ("": not checked), HSTS]
  const cases: [Request, number, string, string | null][] = [
    [req("/"), 0, PAGE_CSP, HSTS],
    [req("/api/session"), 200, API_CSP, HSTS],
    [req("/api/nope"), 404, API_CSP, HSTS], // errors too
    [req("/auth/login?channel=nesszerra"), 0, API_CSP, HSTS], // redirects too
    [req("/robots.txt"), 0, "", HSTS],
    // plain http (local dev) gets no HSTS
    [new Request("http://127.0.0.1:5173/api/session"), 0, API_CSP, null],
  ];
  for (const [request, code, csp, hsts] of cases) {
    const r = await worker.fetch(request, env);
    if (code) assert.equal(r.status, code, request.url);
    if (csp) assert.equal(r.headers.get("Content-Security-Policy"), csp, request.url);
    assert.equal(r.headers.get("Strict-Transport-Security"), hsts, request.url);
  }
});

test("secure() leaves WebSocket upgrades alone and copes with immutable headers", () => {
  // a stand-in for a 101 upgrade, which Response cannot construct here; secure() reads only status and webSocket
  const upgrade = { status: 101, webSocket: {}, headers: new Headers() } as unknown as Response;
  assert.equal(secure(upgrade, new URL(ORIGIN + "/api/live/x"), API_CSP), upgrade);
  const redirect = secure(Response.redirect(ORIGIN + "/", 302), new URL(ORIGIN + "/"), API_CSP);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("Location"), ORIGIN + "/");
  assert.equal(redirect.headers.get("Strict-Transport-Security"), HSTS);
  const own = secure(
    new Response("x", { headers: { "Content-Security-Policy": "default-src 'none'" } }),
    new URL(ORIGIN + "/"),
    PAGE_CSP,
  );
  assert.equal(own.headers.get("Content-Security-Policy"), "default-src 'none'", "a policy the handler set is kept");
});

// ---------- health ----------
test("public health check says only whether the server is up", async () => {
  const { env } = environment();
  assert.deepEqual(await call(env, "/api/health"), { status: 200, body: { ok: true } });
  // a missing secret on purpose: the test checks the 503
  for (const broken of [asEnv({ ...env, AUTH_SECRET: undefined }), { ...env, INTERNAL_SECRET: "" }])
    assert.deepEqual(await call(broken, "/api/health"), { status: 503, body: { ok: false } });
});

// ---------- per-user write limit ----------
test("hit(): the 31st write in a minute is refused; the window slides instead of resetting all at once", async () => {
  const { ctx } = sqliteAuth(), // AuthStore creates the entries table
    T = 10 * 60000; // the start of a window
  const limited = async (key: string, at: number) => (await hit(ctx, key, 30, 60000, at)).limited;
  for (let i = 0; i < WRITE_LIMIT; i++) assert.equal(await limited("a", T + i), false, "write " + (i + 1));
  const refused = await hit(ctx, "a", 30, 60000, T + 30);
  assert.equal(refused.limited, true);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 125, "retryAfter " + refused.retryAfter);
  assert.equal(await limited("b", T + 30), false, "another user is not affected");
  assert.equal(await limited("a", T + 30), true, "a refused write is not counted, but the count stays");
  // 30 writes at the end of one window, then the next window opens: not 30 more at once
  const late = 20 * 60000;
  for (let i = 0; i < 30; i++) assert.equal(await limited("c", late - 1000 + i), false);
  assert.equal(await limited("c", late + 1), true, "still inside the last minute");
  // waiting what retryAfter says is enough, and it is not an overestimate by a whole window
  const wait = (await hit(ctx, "c", 30, 60000, late + 1)).retryAfter;
  assert.equal(await limited("c", late + wait * 1000 + 1), false, "allowed after retryAfter");
  assert.ok(wait <= 125);
  // after a full quiet minute everything is open again
  assert.equal(await limited("a", T + 3 * 60000), false);
  // counts expire with AuthStore's hourly sweep, and it is scheduled
  assert.ok((ctx.storage.alarm as number) > 0); // null fails the comparison, as it did before types
  assert.ok(ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM entries WHERE key LIKE 'rl:%'").toArray()[0].n > 0);
});

test("profile saves: the 31st in a minute is 429 with Retry-After; reads are not counted; the limit is per user", async () => {
  const f = environment(),
    viewer = await signIn(f.env, VIEWER),
    other = await signIn(f.env, OTHER);
  const save = (cookie: string) => worker.fetch(req("/api/profile/nesszerra", "POST", profile, cookie), f.env),
    read = () => status(f.env, "/api/profile/nesszerra", "GET", undefined, viewer);
  for (let i = 0; i < 40; i++) assert.equal(await read(), 200, "reads are free");
  assert.equal(f.hits.length, 0, "reads never touch the counter");
  for (let i = 0; i < 30; i++) assert.equal((await save(viewer)).status, 200, "save " + (i + 1));
  const before = f.rooms.length;
  const refused = await save(viewer);
  assert.equal(refused.status, 429);
  const body = await refused.json<Loose>(); // Loose: the error body, read by field below
  assert.equal(body.reason, "rate_limited");
  assert.match(body.error, /Too many/);
  assert.ok(Number.isInteger(body.retryAfter) && body.retryAfter >= 1 && body.retryAfter <= 125);
  assert.equal(refused.headers.get("Retry-After"), String(body.retryAfter));
  assert.equal(refused.headers.get("Content-Security-Policy"), API_CSP);
  assert.equal(f.rooms.length, before, "a refused write never reaches the room");
  assert.equal((await save(other)).status, 200, "another user can still save");
  assert.equal(await read(), 200, "the user can still read");
  assert.equal(f.hits.length, 32, "one AuthStore call per write, none for reads");
});

test("shop buys, uploads and admin changes share the user's 30 writes a minute, across channels", async () => {
  const { env } = environment(),
    owner = await signIn(env, OWNER);
  const calls: [string, object][] = [
    ["/api/shop/nesszerra", { kind: "pet", id: "cat" }],
    ["/api/assets/nesszerra", {}],
    ["/api/pets/nesszerra", {}],
    ["/api/admin/nesszerra", { action: "resetRound" }],
    ["/api/profile/miolafff", profile],
  ];
  for (let i = 0; i < 30; i++) {
    const [path, data] = must(calls[i % calls.length]);
    assert.notEqual(await status(env, path, "POST", data, owner), 429, "write " + (i + 1));
  }
  for (const [path, data] of calls) assert.equal(await status(env, path, "POST", data, owner), 429, path);
  // GETs on the same routes still work
  assert.equal(await status(env, "/api/admin/nesszerra", "GET", undefined, owner), 200);
  assert.equal(await status(env, "/api/shop/nesszerra"), 200);
});

test("dev-token requests and signed-out requests are not counted", async () => {
  const f = environment({ DEV_TOKEN_UNUSED: 1, DEV_TOOLS_TOKEN: DEV_TOKEN });
  for (let i = 0; i < 40; i++) {
    const code = await status(f.env, "/api/admin/nesszerra", "POST", { action: "resetRound" }, undefined, {
      Authorization: "Bearer " + DEV_TOKEN,
    });
    assert.equal(code, 200, "dev write " + (i + 1));
  }
  assert.equal(f.hits.length, 0);
  assert.equal(await status(f.env, "/api/profile/nesszerra", "POST", profile), 401);
  assert.equal(f.hits.length, 0, "no session, nothing to count");
});

test("if AuthStore cannot count, the write goes through instead of failing", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { env } = environment({}, true),
    viewer = await signIn(env, VIEWER);
  assert.equal(await status(env, "/api/profile/nesszerra", "POST", profile, viewer), 200);
});
