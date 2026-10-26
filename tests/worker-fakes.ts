// Shared doubles for the Worker tests: the bindings every test sets, AuthStore in memory or on real SQLite, room
// namespaces, a signed-in session, and requests shaped like the browser's.
import worker from "../server/worker.ts";
import { AuthStore, digest, record } from "../server/auth.ts";
import type { TestContext } from "node:test";
import type { Env } from "../server/env.ts";
import { asEnv, fakeCtx, must, type Loose } from "./fakes.ts";

export const ORIGIN = "https://chat.miolaf.xyz",
  INTERNAL = "test-only-internal-key";
/** The secrets every Worker test binds. */
export const SECRETS = {
  AUTH_SECRET: "test-only-auth-key",
  INTERNAL_SECRET: INTERNAL,
  TWITCH_CLIENT_ID: "test-app",
  TWITCH_CLIENT_SECRET: "test-secret",
};
export type User = { id: string; login: string; displayName: string };
export const OWNER: User = { id: "1", login: "nesszerra", displayName: "nesszerra" },
  VIEWER: User = { id: "2", login: "viewer", displayName: "Viewer" };

/** What a stub receives from the Worker: JSON bodies arrive as strings. */
export type StubInit = { method?: string; body?: string; headers?: HeadersInit };
export type Stub = { fetch(url: string, init?: StubInit): Promise<Response> };
/** A namespace fake: ids are the names themselves, and get returns a stub for that name. */
export type Namespace = { idFromName(name: string): string; get(name: string): Stub };
/** A namespace whose stubs answer with `fetch`, typed as the binding it stands in for. */
export const namespace = (fetch: (name: string, url: string, init: StubInit) => Promise<Response>) =>
  ({
    idFromName: (x: string) => x,
    get: (name: string) => ({ fetch: (url: string, init: StubInit = {}) => fetch(name, url, init) }),
  }) satisfies Namespace as Namespace & DurableObjectNamespace; // a fake in place of the binding

const DAY = 86400000;
/**
 * AuthStore as two maps (values and expiry times), with the real store's expiry cap: years only for channel rows.
 * Write limits always pass.
 */
export function memoryAuth(entries = new Map<string, Loose>(), expires = new Map<string, number>()) {
  return namespace(async (_, url, init) => {
    const u = new URL(url),
      key = u.searchParams.get("key") ?? "";
    if (u.pathname === "/hit") return Response.json({ limited: false, retryAfter: 0 });
    if (u.pathname === "/list")
      return Response.json([...entries].filter(([k]) => k.startsWith(key)).map(([k, value]) => ({ key: k, value })));
    const value = entries.get(key) ?? null;
    if (u.pathname === "/consume" || init.method === "DELETE") {
      entries.delete(key);
      expires.delete(key);
      return Response.json(u.pathname === "/consume" ? value : { ok: true });
    }
    if (init.method === "GET") return Response.json(value);
    const body = JSON.parse(String(init.body));
    if (
      !Number.isFinite(body.expires) ||
      body.expires > Date.now() + (/^(channel|modsconnected|bot):/.test(key) ? 21 * 365 : 100) * DAY
    )
      return Response.json({ error: "Invalid expiry" }, { status: 400 });
    entries.set(key, body.value);
    expires.set(key, body.expires);
    return Response.json({ ok: true });
  });
}

/** The real AuthStore on node:sqlite; `ctx.storage.alarm` shows the alarm it set. */
export function sqliteAuth() {
  const ctx = fakeCtx(),
    store = new AuthStore(ctx, asEnv({ INTERNAL_SECRET: INTERNAL }));
  return { store, ctx, AUTH: namespace((_, url, init) => store.fetch(new Request(url, init))) };
}

/** A session cookie for `user`, stored the way sign-in stores it. */
export async function signIn(env: Env, user: User = VIEWER): Promise<string> {
  const cookie = user.id
    .padStart(64, "c")
    .slice(-64)
    .replace(/[^a-f0-9]/g, "c");
  await record(env, "session:" + (await digest(cookie)), { user }, Date.now() + 3600000);
  return "mini_session=" + cookie;
}
/** Signs in the owner or the viewer on an in-memory store, with the owner record set. */
export async function signedIn(f: { env: Env; entries: Map<string, Loose> }, owner = false): Promise<string> {
  f.entries.set("owner:nesszerra", { id: "1" });
  return signIn(f.env, owner ? OWNER : VIEWER);
}

/** A same-origin request; writes carry Origin and a JSON body (a string is sent as is). */
export function req(
  path: string,
  method = "GET",
  data?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: ORIGIN, "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(data !== undefined ? { body: typeof data === "string" ? data : JSON.stringify(data) } : {}),
  });
}
/** The Worker's answer to req(...): the status and the JSON body (null when it is not JSON). */
export async function call(env: Env, ...args: Parameters<typeof req>): Promise<{ status: number; body: Loose }> {
  const r = await worker.fetch(req(...args), env);
  return { status: r.status, body: await r.json<Loose>().catch(() => null) };
}
export const status = async (env: Env, ...args: Parameters<typeof req>) =>
  (await worker.fetch(req(...args), env)).status;

/** Mocks fetch for Twitch: the app token comes from id.twitch.tv, every other call from `api`. */
export function twitchApi(
  t: TestContext,
  api: (
    url: URL,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ) => Response | Promise<Response>,
) {
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init = {}) => {
    const u = new URL(String(url));
    return u.host === "id.twitch.tv" ? Response.json({ access_token: "app-token-1", expires_in: 5000 }) : api(u, init);
  });
}

/**
 * A Twitch sign-in from /auth/login?<query> through the callback, as `as` with the granted `scopes`. The channel
 * owner's lookup answers `owner`, or that Response for a failed one. Returns the callback's answer.
 */
export async function twitchSignIn(
  t: TestContext,
  env: Env,
  query: string,
  { as = VIEWER, scopes = [], owner = OWNER }: { as?: User; scopes?: string[]; owner?: User | Response } = {},
): Promise<Response> {
  const helix = (u: User) => Response.json({ data: [{ id: u.id, login: u.login, display_name: u.displayName }] });
  const twitch = t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token", refresh_token: "refresh-1" });
    if (u.endsWith("/oauth2/validate"))
      return Response.json({ client_id: SECRETS.TWITCH_CLIENT_ID, user_id: as.id, scopes });
    if (u.includes("users?login=" + OWNER.login)) return owner instanceof Response ? owner : helix(owner);
    return helix(as);
  });
  const login = await worker.fetch(new Request(ORIGIN + "/auth/login?" + query), env),
    state = new URL(must(login.headers.get("Location"))).searchParams.get("state");
  const r = await worker.fetch(
    new Request(ORIGIN + "/auth/callback?code=c&state=" + state, { headers: { Cookie: "mini_oauth=" + state } }),
    env,
  );
  twitch.mock.restore();
  return r;
}
