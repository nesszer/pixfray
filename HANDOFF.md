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
- Use free, licensed assets only (CC0 preferred). Record each source in `ASSET_LICENSES.md`.
- Ignore the `cf build` Docker error ("failed to connect to the docker API"); it's harmless.
- Plain scripted HTTP requests to the domain get Cloudflare error 1010. Test with a browser or Playwright.

## Current state

### V1 (done and deployed)

| File | Purpose |
|---|---|
| `public/overlay.html`, `public/overlay.js` | Canvas overlay, characters walk and show chat |
| `public/chat.js` | Anonymous Twitch IRC adapter (justinfan) |
| `index.html`, `src/setup.js`, `public/setup.css` | Setup page that builds the overlay URL |
| `public/assets/characters.json` + 5 PNGs | Kenney CC0 characters: adventurer, female, player, soldier, zombie |
| `tests/smoke.mjs` | Playwright smoke test (`npm test`) |
| `README.md`, `VALIDATION.md`, `ASSET_LICENSES.md`, `LICENSE` (MIT) | Docs |

### V2 (written, never run, built, deployed or tested)

| File | Lines | Status |
|---|---|---|
| `server/worker.js` | 98 | Router. Imports `./developer.js`, which **doesn't exist**, so the build fails until it's added |
| `server/auth.js` | 138 | AuthStore DO, Twitch OAuth, AES-GCM sealing, sessions, Helix mod check |
| `server/channel.js` | 515 | ChannelRoom DO (per-channel state, profiles, leaderboard, admin, relay socket) |
| `server/game.js` | 749 | Pure combat reducer: `reduceGame`, `parseGameCommand`, `applyProfile`, `defaultConfig` |
| `public/arena-client.js` | 185 | Overlay-side client for shared arena state |
| `relay/lib/{config,core,log}.mjs`, `relay/dpapi.ps1`, `relay/package.json` | 234 | Relay library only. **No entry script, OBS launcher or installer yet** |
| `scripts/configure-twitch.ps1`, `TWITCH_SETUP.md` | — | Sets Worker secrets from local input |
| `tests/auth.test.mjs`, `tests/cloudflare-test-loader.mjs`, `tests/arena-browser.mjs` | — | Never run |
| `cloudflare.config.ts` | — | Declares ASSETS, ROOMS, AUTH, AUTH_SECRET, INTERNAL_SECRET, PUBLIC_ORIGIN. **TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET bindings are missing** |

All files pass `node --check`.

### Known bugs and gaps

1. `server/developer.js` is missing (`handleDeveloper` for `/api/dev/*`).
2. `cloudflare.config.ts` lacks the `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` secret bindings.
3. Relay pairing-code consume isn't atomic (`consume()` in `server/auth.js`). Make it a single DO transaction.
4. The viewer dashboard, admin dashboard, upload UI and live-fix UI aren't written.
5. Only the 5 v1 characters exist. The 5–10 launch additions and the 30+ reserve haven't been sourced.
6. The relay has no runnable entry point and no OBS start/stop hook.
7. No GitHub repo yet (to be created under `Finesssee`; the folder isn't a git repo).

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
- If the relay drops, combat pauses and unfinished duels are cancelled without scoring.

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
- Live settings editor, error logs and diagnostics (relay status, request usage, DO errors).
- Code editor, restricted to the `nesszerra` account (`isOwner`):
  - GitHub-backed flow: save → deploy test version (`test.chat.miolaf.xyz`) → check in OBS → promote.
  - Immediate hotfix path.
  - Rollback to the previous version.
  - Codex assists only when the owner explicitly authorizes it.

### Local relay (`relay/`)
- Windows Node app on the OBS PC that starts and stops with OBS.
- Reads chat through Twitch EventSub WebSocket (`user:read:chat`) and forwards game commands to
  the Worker over one WebSocket. This keeps request usage within Cloudflare Free.
- Twitch tokens stay local, encrypted with DPAPI (`dpapi.ps1`).
- Pairing: the owner generates a one-time code on the site (`/api/relay/code`), and the relay
  exchanges it (`/api/relay/pair`) for a 90-day credential that can be revoked (`/api/relay/revoke`).

## Prerequisites (owner does these)

1. Create a Twitch Developer app with the OAuth redirect `https://chat.miolaf.xyz/auth/callback`
   (and `https://test.chat.miolaf.xyz/auth/callback` for the test Worker).
2. Set Worker secrets `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `AUTH_SECRET` and `INTERNAL_SECRET`
   (`scripts/configure-twitch.ps1`).
3. Create the GitHub repo under `Finesssee`.
4. Sign in once as nesszerra with `connect=1` to store the broadcaster token for mod checks.

## Suggested workstreams

Parallel lanes A–E share contracts through `server/game.js` (state shape) and `server/worker.js` (routes).
Lock those two first, then run the lanes in parallel.

| Lane | Scope | Done when |
|---|---|---|
| A. Backend core | Add `developer.js`, Twitch bindings, atomic pairing; unit-test `game.js` against the spec above; get `cf build` and `cf dev` running | Build is green, reducer tests cover every combat rule, auth tests pass |
| B. Viewer + admin UI | `/` dashboard, `/admin` controls and versioned editor, following `~/.claude/design/design.md` | Pages work at 1280 px and 390 px, `design.py check` has no FAILs |
| C. Relay | Entry script, EventSub client, pairing CLI, OBS start/stop hook, reconnect with backoff | Relay pairs, forwards commands, and combat pauses when it's killed |
| D. Content + uploads | Source 5–10 launch characters and a 30+ reserve, update `characters.json` and `ASSET_LICENSES.md`, browser atlas packer + server validation | 10–15 characters render, uploads enforce every limit |
| E. Live-fix + deploy | `/admin/dev` logs/diagnostics, GitHub save → test deploy → promote → rollback, owner-only gate | A change goes test → promote → rollback end to end |
| F. Acceptance | Runs after A–E | All four stages below pass |

Acceptance order:
1. Simulated fights and uploads in the local OBS scene (OBS WebSocket 5.x on port 4455;
   helper scripts in `D:\code\2026-10-01\i-ne\work\obs-*.mjs`). Restore the user's "Scene 2" afterwards.
2. Real chat commands on the nesszerra channel.
3. Relay reconnects, rank persistence across restarts, and rollback.
4. Private rehearsal with the owner and mods.
