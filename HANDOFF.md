# Mini Chat v2 handoff

Project root: `D:\code\2026-10-01\i-ne\outputs\mini-chat`
Live v1: https://chat.miolaf.xyz (Cloudflare Workers Free, Worker `nesszerra-mini-chat`)
Test target: `cf build/deploy --mode test` → Worker `nesszerra-mini-chat-test` on `test.chat.miolaf.xyz`

## Rules for every agent

- Never permanently delete files. Use `~/.claude/bin/trash "<abs path>"`.
- Never put the owner's real name in code, commits or licenses. Use "nesszerra" or "ness truong".
- Never print or commit secrets: `.dev.vars`, `D:\code\2026-10-01\i-ne\work\mini-chat-secrets.json`,
  the OBS WebSocket password, or the Twitch client secret.
- Only the `nesszerra` channel is enabled. `miolafff` (production) stays disabled until its owner
  authorizes it.
- Stay on Cloudflare Free: 100k Worker requests/day, SQLite-backed Durable Objects only.
  Budget: each chat message in nesszerra's chat is 1 Worker request (the EventSub webhook) plus
  1 Durable Object request, whether or not it is a command. Free allows 100k Worker requests a
  day, shared with page loads, overlay polling and API calls, so heavy chat days need watching on
  `/admin/dev` (request usage).
- Use free, licensed assets only (CC0 preferred). Record each source in `ASSET_LICENSES.md`.
- Ignore the `cf build` Docker error ("failed to connect to the docker API"); it's harmless.
- Plain scripted HTTP requests to the domain get Cloudflare error 1010. Test with a browser or Playwright.

## Current state

Updated 2026-10-01 after the integration pass. Nothing is committed, pushed or deployed: the
working tree sits on top of the baseline commit (`git diff` shows every change). The live site
still runs v1.

### V1 (deployed, unchanged on the live site)

`public/overlay.html` + `public/overlay.js` (canvas overlay), `public/chat.js` (anonymous IRC),
the setup section of `index.html`, and `tests/smoke.mjs`. The v1 smoke test still passes locally.

### V2 (built and tested locally, not deployed)

| Area | Files | Local status |
|---|---|---|
| Backend core | `server/worker.js`, `channel.js`, `auth.js`, `game.js`, `eventsub.js`, `cloudflare.config.ts` | `npx cf build` and `npx cf build --mode test` pass; 122 unit tests pass |
| Viewer + admin UI | `index.html`, `admin/index.html`, `src/`, `public/dashboard.css` | `tests/ui.mjs` passes at 1280/390; design check has 0 FAIL |
| Overlay arena | `public/overlay.js` (`arena=1`), `public/arena-client.js` | `tests/arena-browser.mjs` and the live E2E pass |
| Chat (EventSub webhook) | `server/eventsub.js`, the chat steps in `server/channel.js` | Signed-webhook unit tests and the local E2E pass; not yet run against real Twitch |
| Content + uploads | 15 characters, `server/uploads.js`, `public/upload.js`, `docs/CHARACTER_RESERVE.md` | Upload tests and `tests/upload-workerd.mjs` pass |
| Live-fix | `server/developer.js`, `admin/dev/`, `public/dev.js`, `scripts/release.mjs`, `.github/` | `tests/dev-ui.mjs` and dev API tests pass with mocked GitHub/Cloudflare |

Run it all with `npm run test:all` (see `VALIDATION_V2.md` for the exact commands and the spec
audit). The local E2E (`tests/e2e-local.mjs`) runs against `npx cf dev` started with
`MINI_LOCAL_TEST=1`. It connects chat (a local subscription, no Twitch call), sends chat as signed
EventSub webhooks, and plays out these steps:

1. Two viewers appear in the arena.
2. `!challenge` / `!accept`, then attacks with cooldowns, until a KO.
3. Elo 1012/988 and the leaderboard update.
4. The rematch delay, the sign-in requirement, the busy player check and the inactivity cancel.
5. Replayed, badly signed and stale webhooks change nothing.
6. Disconnect chat pauses combat and cancels the duel unscored; a revocation pauses it again.

Screenshots are in `screenshots/e2e-*.png`.

### Known bugs and gaps

1. Not verified with real Twitch: sign-in (OAuth), the Helix moderator check, the app token, and
   the EventSub webhook (subscription create, callback verification, real chat delivery). There is
   no Twitch app yet, and local `.dev.vars` has no Twitch client, so `/api/session` reports
   `configured:false`. Local runs use seeded test sessions (`tests/seed-local.mjs`). A real
   subscription needs the deployed https site; Twitch cannot call localhost.
2. Live-fix GitHub/Cloudflare flow (save → test deploy → promote → hotfix → rollback) is only
   tested against mocked APIs. It needs the GitHub repo plus `GITHUB_TOKEN`, `GITHUB_REPO`,
   `CF_API_TOKEN` and `CF_ACCOUNT_ID` set as Worker secrets (docs/LIVE_FIX.md).
3. Twitch sends chat to the webhook only after nesszerra grants `user:read:chat`, `user:bot` and
   `channel:bot` (sign in at `/auth/login?connect=1`). Until then Connect chat answers 403 with a
   Reconnect Twitch link.
4. Acceptance stages 1–4 below (OBS scene, real chat, restarts and rollback, rehearsal) have not
   been run.
5. No GitHub repo exists yet and nothing is committed.
6. `tests/smoke.mjs` joins the real #nesszerra IRC anonymously and rewrites the tracked
   `setup-preview.png` and `overlay-preview.png`.
7. The room refreshes a chat-only viewer's presence at most once per 30 s, so such a viewer can
   take up to 30 s to reappear after the 10 min idle timeout. Every message still costs a Worker
   and a DO request (see the budget note above).
8. With `debug=1` at 390 px, the overlay's debug status line covers the top announcement. This
   only affects debug mode.
9. During this pass, another `npx vite` dev server of this project (pid 6560) was holding port
   5173. It was left running. Tests use `MINI_PORT=5199` and their own state folder
   (`.cloudflare/e2e-state`).

Fixed in this pass:
- `arena-client.js` built its WebSocket with an arrow function called with `new`, so the live
  overlay never connected (it fell back to polling).
- `resetAll` didn't clear players or rematch locks, even though the contract and the admin UI
  say it does.
- The local relay was replaced by a Twitch EventSub webhook to the Worker, so chat runs only on
  Cloudflare. Rejected commands are logged as `command_rejected` events (with `retryAt` for
  cooldowns), since Twitch gets no reply.
- Config history records `actorName` (admin and live-fix).
- The uploader's layout was squeezed inside the admin `.controls` grid.
- A gradient checkerboard failed the design check.
- The admin page had two primary buttons.
- The setup page's OBS URL now adds `arena=1`.
- `CF_VERSION_METADATA` binding added.
- `tests/arena-browser.mjs` now uses contract event shapes.

## Agreed v2 spec

### Channels
- One ChannelRoom per channel. Profiles, Elo and settings are separate per channel.
- `nesszerra` is enabled for testing. `miolafff` is disabled until its owner authorizes it.

### Viewer dashboard (`/`)
- Twitch sign-in. Profiles are saved server-side, so they follow the viewer across devices.
- Character cards with a live preview, nameplate color, default ability (strike, heavy or heal), and a compact leaderboard.

### Overlay
- A viewer's character appears after their first chat message and loads their saved profile.
- Duels happen where the characters stand, with health bars and hit/heal effects.
- The server decides all combat. Every OBS source renders the same shared state.

### Combat
- Opt-in: `!challenge @user`, and the target accepts (e.g. `!accept`). Challenges expire after 30 s.
- `!attack @viewer` uses the viewer's default ability. All three abilities can be used by command
  (e.g. `!strike`, `!heavy`, `!heal`). The website choice only sets the default.
- Cooldowns run in real time.
- Up to 5 simultaneous duels per channel, one duel per viewer.
- Each accepted duel counts as one round. A knocked-out character respawns.
- Completed duels update wins/losses and Elo (start 1000, K=24). Rematches between the same pair wait 30 s.
- 60 s of inactivity cancels a duel with no scoring.
- Ranked duels require a signed-in profile.
- If chat is disconnected or Twitch revokes the subscription, combat pauses and unfinished duels
  are cancelled without scoring.

### Balance preset (approved, editable by mods)

| Setting | Value |
|---|---|
| HP | 100 |
| Strike | 10 damage, 3 s cooldown |
| Heavy strike | 25 damage, 8 s cooldown |
| Heal | 15 HP, 10 s cooldown |
| Shared action delay | 1 s |

### Mod and broadcaster controls (`/admin`)
- Access goes to the broadcaster and current Twitch mods, verified live through Helix
  `/moderation/moderators` (broadcaster token with `moderation:read`, stored sealed in AuthStore).
- Controls: enable/disable duels, cancel duels, reset health, round management, score and rank
  resets, and a full versioned editor (with history) for balance, abilities and rules.
- The page shows custom-character usage against the limits below.

### Characters
- Launch with 10–15: the existing 5 plus 5–10 new licensed free characters.
- Keep a vetted reserve of 30+ characters (license recorded) ready to import later.
- Characters without combat animations use effects (flash, knockback, particles) instead.

### Uploads (broadcaster and mods)
- Either one PNG (animated by the engine with movement and effects) or PNG frames for idle, walk,
  attack and knockout.
- Frames are aligned and packed into an atlas in the browser, with a preview before saving.
- Limits: PNG only, 24 frames max, 128×128 per frame, 1.5 MB per atlas, 8 custom characters per channel.
- Validate the limits on the server as well as in the browser.

### Live-fix space (`/admin/dev`)
- Live settings editor, error logs and diagnostics (chat status, request usage, DO errors).
- Code editor, restricted to the `nesszerra` account (`isOwner`):
  - GitHub-backed flow: save → deploy test version (`test.chat.miolaf.xyz`) → check in OBS → promote.
  - Immediate hotfix path.
  - Rollback to the previous version.
  - Codex assists only when the owner explicitly authorizes it.

### Chat source (Cloudflare only)
- Twitch EventSub `channel.chat.message` delivered by webhook to `POST /api/eventsub`. Nothing
  runs on the OBS PC.
- The owner or a mod clicks Connect chat on `/admin/`. The Worker keeps exactly one subscription
  (app token, cached sealed) and deletes stale ones. The room re-checks it hourly (every 3 min
  while Twitch is still verifying the webhook, so a failed verification shows up on `/admin/`).
- One site at a time: both sites share one Twitch app and Twitch allows one chat subscription per
  channel, so Connect chat on the second site answers 409 "Chat is connected to <origin>" and
  offers to move it (`takeover:true` deletes the other site's subscription). Use a second Twitch
  app for the test site if both must receive chat at once.
- The Worker forwards only the event fields the room reads, so emote-heavy messages stay small;
  a room 4xx is acknowledged (204) so one bad message can't trigger Twitch retries and revocation.
- Requests are HMAC-verified with a secret derived from `AUTH_SECRET`, limited to 64 KB, must be
  at most 10 min old, and are deduplicated (CONTRACTS.md section 4).

## Prerequisites (owner does these)

1. Create a Twitch Developer app with the OAuth redirect `https://chat.miolaf.xyz/auth/callback`
   (and `https://test.chat.miolaf.xyz/auth/callback` for the test Worker).
2. Set Worker secrets `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `AUTH_SECRET` and `INTERNAL_SECRET`
   (`scripts/configure-twitch.ps1`).
3. Create the GitHub repo under `Finesssee`.
4. Deploy, sign in once as nesszerra at `/auth/login?connect=1` (stores the broadcaster token for
   mod checks and grants the chat scopes), then click Connect chat on `/admin/` (TWITCH_SETUP.md).

## Suggested workstreams

Parallel lanes A–E share contracts through `server/game.js` (state shape) and `server/worker.js` (routes).
Lock those two first, then run the lanes in parallel.

| Lane | Scope | Done when |
|---|---|---|
| A. Backend core | Add `developer.js`, Twitch bindings, the EventSub webhook; unit-test `game.js` against the spec above; get `cf build` and `cf dev` running | Build is green, reducer tests cover every combat rule, auth tests pass |
| B. Viewer + admin UI | `/` dashboard, `/admin` controls and versioned editor, following `~/.claude/design/design.md` | Pages work at 1280 px and 390 px, `design.py check` has no FAILs |
| C. Chat | EventSub webhook, Connect/Disconnect chat, hourly Helix check | Signed chat drives duels; disconnect and revocation pause combat |
| D. Content + uploads | Source 5–10 launch characters and a 30+ reserve, update `characters.json` and `ASSET_LICENSES.md`, browser atlas packer + server validation | 10–15 characters render, uploads enforce every limit |
| E. Live-fix + deploy | `/admin/dev` logs/diagnostics, GitHub save → test deploy → promote → rollback, owner-only gate | A change goes test → promote → rollback end to end |
| F. Acceptance | Runs after A–E | All four stages below pass |

Acceptance order:
1. Simulated fights and uploads in the local OBS scene (OBS WebSocket 5.x on port 4455;
   helper scripts in `D:\code\2026-10-01\i-ne\work\obs-*.mjs`). Restore the user's "Scene 2" afterwards.
2. Real chat commands on the nesszerra channel.
3. Chat reconnects after a revocation, rank persistence across restarts, and rollback.
4. Private rehearsal with the owner and mods.
