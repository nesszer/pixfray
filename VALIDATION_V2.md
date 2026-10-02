# Mini Chat v2 validation

Local validation on 2026-10-01 (Windows 11, Node 22.22.0, installed Chrome, `cf` 1.0.0-beta.9).
Nothing was deployed, committed or pushed. No real Twitch, GitHub or Cloudflare API was called,
except that `tests/smoke.mjs` joins the public #nesszerra IRC anonymously, read-only.

## Result

`npm run test:all` passed every stage (run after the local relay was replaced by the Twitch
EventSub webhook):

| Stage | Command | Result |
|---|---|---|
| Unit tests | `npm run test:unit` | 122 tests, 122 pass, 0 fail, 0 skipped |
| Production build | `npx cf build` | "Build complete" |
| Test build | `npx cf build --mode test` | "Build complete" |
| Uploads in workerd | `node tests/upload-workerd.mjs` | 5 of 5 checks pass |
| v1 overlay smoke | `node tests/smoke.mjs` | PASS (also joins the public #nesszerra IRC anonymously) |
| Dashboard + admin UI | `node tests/ui.mjs` | PASS at 1280 and 390 |
| Live-fix UI | `node tests/dev-ui.mjs` | PASS, including one unstubbed owner run with a seeded session |
| Overlay arena client | `node tests/arena-browser.mjs` | PASS (contract event shapes, dedupe, stale events and revisions, reconnect, demo) |
| Local end to end | `node tests/e2e-local.mjs` | E2E PASS |

`python ~/.claude/design/design.py check` reports 0 FAIL and 0 WARN on these files:
- `index.html`
- `admin/index.html`
- `admin/dev/index.html`
- `public/dashboard.css`, `public/upload.css`, `public/dev.css`

`public/overlay.html` reports 0 FAIL and 2 WARN (no `h1`, no design.css). Both are intentional:
the page is a transparent OBS canvas with no text content.

## How the local end-to-end run works

`scripts/test-all.mjs` sets up the server like this:
1. Starts `npx cf dev` with `MINI_PORT=5199` and `MINI_PERSIST=.cloudflare/e2e-state`, so it never
   shares state or a port with another dev server.
2. Creates the local AuthStore, stops the server, and seeds test-only sessions with
   `tests/seed-local.mjs`: owner 900001 `nesszerra`, plus `alice_e2e`, `bob_e2e` and `carol_e2e`.
3. Starts the server again with `MINI_LOCAL_TEST=1`, so Connect chat records a local
   subscription without calling Twitch (only on a loopback `cf dev`; builds refuse the flag).

`tests/e2e-local.mjs` signs EventSub webhooks with the secret derived from `AUTH_SECRET`.
`scripts/test-all.mjs` reads that value from `.dev.vars` (or `MINI_AUTH_SECRET`) and passes it
only to the e2e process environment; nothing prints it.

`tests/e2e-local.mjs` then runs these steps:

1. **Clean start.** `resetAll` and `resetAllRanks` as the owner.
2. **Profiles.** Alice (toon-ranger, strike) and Bob (alien-blue, heavy) save profiles through
   `POST /api/profile`. A POST without `Origin` gets 403.
3. **Config.** The owner saves maxHp 60 and inactivity 10 s with `baseVersion`. A stale
   `baseVersion` gets 409. A viewer gets 403 on `/api/admin`. History shows the note and
   `actorName: nesszerra`.
4. **Overlay before chat is connected.** The overlay (`?channel=nesszerra&arena=1&debug=1`) opens
   in Chrome on the real live socket and shows a paused game. A second overlay without debug shows
   "Duels paused".
5. **Connect chat.** A viewer gets 403. The owner connects; the state shows chat connected and
   the game unpaused. A `webhook_callback_verification` gets its challenge back as text. A badly
   signed message and one with an 11-minute-old timestamp both get 403 and change nothing.
6. **Two viewers.** Chat messages from alice and bob put exactly 2 characters on the overlay, with
   their saved avatar and color.
7. **Duel to KO.** These commands arrive as signed `channel.chat.message` webhooks. Twitch gets no
   reply, so each outcome is read from the room events (`command_rejected` for refusals). Sending
   the challenge again with the same Message-Id, and again with a new Message-Id but the same chat
   `message_id`, changes nothing:

   | Command | Result |
   |---|---|
   | `!challenge @bob_e2e`, then `!accept` | Active duel with `rules.maxHp` 60 |
   | `!heavy` | ok |
   | Immediate `!strike` | `cooldown` with `retryAt` |
   | Bob's `!heavy` | ok |
   | `!strike` after 1.1 s | ok |
   | Another `!strike` | `cooldown` |
   | `!attack`, twice, 3.1 s apart | ok |
   | `!heavy` after its 8 s cooldown | `duel_completed` |

   The overlay announces "Alice_E2E wins · Elo +12 · Bob_E2E is knocked out" and marks Bob KO.
8. **Elo.** The leaderboard shows alice 1012 (1-0) at the top and bob 988 (0-1). The overlay
   label updates to 1012.
9. **Rules.** After respawn:
   - Rematch alice→bob returns `rematch_cooldown` with `retryAt`.
   - Unregistered dave returns `ranked_sign_in_required`.
   - Bob challenging carol while she has a pending duel returns `player_busy`.
   - The accepted alice-carol duel is cancelled with `inactivity` after 10 s.
10. **Chat disconnected.** In a new alice-carol duel, after one strike, the owner clicks
    Disconnect chat:
    - The duel is cancelled with `chat_disconnected`.
    - The state is `paused` and chat is disconnected, with no open duels.
    - Elo, wins and losses are unchanged.
    - The non-debug overlay shows "Duels paused · chat offline".
    - A chat message sent after the disconnect has no effect.
    - After reconnecting, a `revocation` (`authorization_revoked`) pauses the game again and the
      reason shows in `chatStatus`.
11. **Screenshots.** Overlay, dashboard (signed in as alice), admin and dev pages (owner) at 1280
    and 390, saved to `screenshots/e2e-*.png`. Duel and KO frames are in
    `e2e-overlay-duel-1280.png` and `e2e-overlay-ko-1280.png`.
12. **Restore.** Config goes back to maxHp 100 and inactivity 60 s.

To rerun only the browser parts against a running, seeded server:

```
MINI_PORT=5199 MINI_PERSIST=.cloudflare/e2e-state MINI_LOCAL_TEST=1 npx cf dev     # terminal 1
MINI_BASE_URL=http://127.0.0.1:5199 MINI_AUTH_SECRET=<AUTH_SECRET from .dev.vars> node tests/e2e-local.mjs   # terminal 2
```

## Spec audit ("Agreed v2 spec" in HANDOFF.md)

Status values:
- **verified**: proven by the named command in this run.
- **unverified**: implemented, but not proven end to end here.
- **missing**: not implemented.

| Spec item | Status | Evidence |
|---|---|---|
| One ChannelRoom per channel; profiles, Elo and settings separate | unverified | `worker.js` routes every channel to `ROOMS.idFromName(channel)`. Only one channel is enabled, so separation was not exercised |
| nesszerra enabled, miolafff disabled | verified | `npm run test:unit`: "production is inaccessible before broadcaster onboarding", "unknown routes and the disabled production channel" |
| Twitch sign-in | unverified | OAuth state checks pass in `auth.test.mjs`. No Twitch app exists; local runs use seeded sessions |
| Profiles saved server-side, follow the viewer across devices | verified | `e2e-local.mjs`: the profile saved by API shows in a fresh browser context (dashboard 1012 and Ranger). `channel.test.mjs` "profiles are saved server-side" |
| Dashboard: character cards, live preview, color, default ability, compact leaderboard | verified | `tests/ui.mjs`, `screenshots/e2e-dashboard-1280.png` and `-390.png` |
| Character appears after first chat message and loads the saved profile | verified | `e2e-local.mjs` step 6: presence leads to 2 overlay characters with saved avatar and color |
| Duels where characters stand, health bars, hit effects | verified | `e2e-overlay-duel-1280.png` (35/60 bars, -25 floaters, facing duelists), `arena-browser.mjs` |
| Heal effect on the overlay | unverified | `overlay.js` draws +N and particles for `duel_action` heal. Heal math is in `game.test.mjs`, but no browser run used `!heal` |
| Server decides combat; every OBS source renders the same state | verified | `e2e-local.mjs`: two overlay pages on the live socket both follow server state (debug and plain status); all outcomes come from server acks and events |
| Opt-in challenge and accept; challenges expire after 30 s | verified | `game.test.mjs` "duels are opt-in", "challenges expire after 30 s"; e2e challenge and accept |
| `!attack` uses the default ability; `!strike`, `!heavy`, `!heal` by command | verified | `game.test.mjs` "!attack uses the default ability"; e2e `!attack`, `!strike`, `!heavy` |
| Cooldowns run in real time | verified | e2e: an immediate `!strike` gets `cooldown` and `retryAt`; ok after 1.1 s, then 3.1 s spacing; heavy after 8 s |
| Up to 5 duels per channel, one per viewer | verified | `game.test.mjs` "at most 5 simultaneous duels", "only one duel at a time"; e2e `player_busy` |
| Each accepted duel is one round; KO'd characters respawn | verified | `game.test.mjs` round and respawn tests; e2e "Round N" announcement, KO, then respawn before the next duel |
| Elo start 1000, K=24, wins/losses; rematch waits 30 s | verified | e2e leaderboard 1012/988 and 1-0/0-1, `rematch_cooldown`; `game.test.mjs` |
| 60 s inactivity cancels unscored | verified | `game.test.mjs` "60 s of inactivity cancels a duel without scoring"; e2e with a 10 s setting gives `inactivity` and no rank change |
| Ranked duels require a signed-in profile | verified | e2e: dave gets `ranked_sign_in_required` |
| Chat loss pauses combat and cancels duels unscored | verified | e2e step 10 (disconnect and revocation); `channel.test.mjs` "chat disconnect cancels open duels without scoring" |
| Balance preset (HP 100, 10/3 s, 25/8 s, 15/10 s, 1 s shared) | verified | `game.test.mjs` "balance preset matches the approved defaults"; admin screenshot |
| Admin access for the broadcaster and current mods via Helix | unverified | Owner allowed and viewer 403 are verified (e2e, `worker.test.mjs`). The Helix moderator lookup needs a broadcaster token and was not run |
| Admin controls: enable/disable, cancel, reset health, rounds, rank resets, versioned editor with history | verified | `tests/ui.mjs` (actions, save, 409, revert); e2e config, 409 and history `actorName`, `resetAll`, `resetAllRanks`; `game.test.mjs` admin tests |
| Admin shows custom-character usage against the limits | verified | `e2e-admin-1280.png` ("0 of 8 custom character slots used", 12 MB atlas budget) |
| Launch with 10–15 characters | verified | 15 entries in `public/assets/characters.json`, each listed in `ASSET_LICENSES.md`; the dashboard shows "15 available" |
| Reserve of 30+ vetted characters | verified | `docs/CHARACTER_RESERVE.md` (about 45 rows with licenses) |
| Characters without combat animations use effects | verified | Launch characters have no attack frames; the e2e duel screenshot shows lunge, knockback, particles and floaters |
| Uploads: one PNG or frames for idle, walk, attack, knockout | verified | `upload.test.mjs`, `tests/upload-workerd.mjs` |
| Frames aligned and packed in the browser, with a preview before saving | unverified | Packer logic is tested in Node (`planAtlas`, `drawAtlas`, "packed plan passes server validation"). The preview UI renders (admin screenshots) but was not driven with real files in Chrome |
| Limits: PNG, 24 frames, 128×128, 1.5 MB, 8 per channel | verified | `upload.test.mjs` limit tests; `tests/upload-workerd.mjs` |
| Limits checked on the server too | verified | `upload.test.mjs` "the room re-validates uploads even from an internal caller", "browser limits match the server limits" |
| Live-fix: settings editor, error logs, diagnostics | verified | `tests/dev-ui.mjs` (with a real owner run), `dev-api.test.mjs`, `e2e-dev-1280.png` |
| Code editor restricted to nesszerra (`isOwner`) | verified | `worker.test.mjs` "developer routes are owner-only"; `auth.test.mjs` "a viewer cannot grant themselves mod or developer permissions" |
| GitHub flow: save → test deploy → check in OBS → promote | unverified | `dev-api.test.mjs` and `dev-release.test.mjs` against mocked GitHub/Cloudflare. No repo or secrets exist; nothing was deployed |
| Immediate hotfix path | unverified | Route and workflow tested with mocks only |
| Rollback to the previous version | unverified | `dev-release.test.mjs` rollback plan with mocks only |
| Codex toggle | removed 2026-10-03 | `dev-api.test.mjs` checks `/api/dev/codex` answers 404 |
| Chat runs only on Cloudflare: EventSub `channel.chat.message` webhook to the Worker | unverified | The real Worker handled signed webhooks in e2e. No real Twitch delivery: that needs the deployed https site, a Twitch app and the chat scopes |
| Webhook security: HMAC signature, 10 min age, 64 KB limit, replay dedupe | verified | `worker.test.mjs` "eventsub: bad signatures, stale or future timestamps, missing headers and oversized bodies are refused"; `channel.test.mjs` "replayed EventSub messages are ignored ..."; e2e bad signature, stale timestamp and replay checks |
| Emote-heavy chat can't break delivery: only needed fields reach the room; a room 4xx is acknowledged | verified | `worker.test.mjs` "eventsub: an emote-heavy message (~30 KB) is forwarded as a few hundred bytes; a room 4xx is acknowledged" |
| Only one site at a time holds the chat subscription (shared Twitch app); Connect chat on the other site is a clear 409 with takeover | verified (mocked Helix) | `worker.test.mjs` "connectChat: a live subscription for the same channel on the other site is a clear 409 unless taken over", "connectChat: a Helix 409 on create ..." |
| A subscription stuck in webhook verification is re-checked every 3 min and a failed verification is shown | verified (mocked Helix) | `channel.test.mjs` "a subscription stuck awaiting verification is re-checked within minutes and a failed verification is recorded" |
| Connect chat keeps exactly one subscription; hourly re-check | unverified | `worker.test.mjs` "connectChat creates exactly one webhook ... deletes stale ones", "keeps an existing matching webhook", "a Twitch authorization error tells the owner to reconnect Twitch"; `channel.test.mjs` hourly alarm test. Helix is mocked |
| Broadcaster grants the chat scopes with `connect=1` | verified | `auth.test.mjs` "connect=1 asks for the chat scopes the EventSub webhook needs", "a connect=1 callback without every chat scope is refused with a restart hint" |

No spec item is missing. The 11 unverified items need things this run couldn't use: real Twitch,
a GitHub repo, Cloudflare API secrets, OBS, or a second enabled channel.

## Changes made during this validation

- `public/arena-client.js`: the default WebSocket factory was an arrow function called with
  `new`, so the overlay's live socket always failed and fell back to polling. It is now a plain
  function.
- `server/game.js`: `resetAll` now clears arena players and rematch locks, as CONTRACTS.md and
  the admin button text say. Regression test added.
- `server/channel.js`: rejected chat commands are logged with `retryAt` (originally relay acks;
  the relay was later removed).
- `server/developer.js`: live-fix config saves record `actorName`; `public/dev.js` shows it.
- `public/upload.css`:
  - The uploader stacks in one column inside the admin `.controls` grid.
  - The gradient checkerboard was replaced, because it failed the design check.
- `vite.config.js` reads `MINI_PORT` and `MINI_PERSIST`.
- New tests and scripts:
  - `scripts/test-all.mjs`
  - `tests/seed-local.mjs`
  - `tests/e2e-local.mjs`
  - `tests/arena-browser.mjs`, rewritten to contract event shapes
  - npm scripts `test:all`, `test:ui`, `test:dev-ui`, `test:upload`, `test:e2e` and `seed:local`
- Line endings were normalised back to LF in `server/auth.js`, `tests/dev-api.test.mjs` and
  `tests/upload-workerd.mjs`.

## Local OBS run (2026-10-01)

OBS Studio scene "Mini Chat — v2 Local", with a browser source on `http://127.0.0.1:5210/overlay.html?channel=nesszerra&arena=1&size=96`. It ran against a local `cf dev` with 10 seeded test viewers and a simulated relay. This run
predates the switch from the relay to the EventSub webhook and has not been repeated since; the
relay checks below describe the removed relay. Driver: `work/obs-v2-run.mjs` (outside the repo). Nothing was streamed, recorded or deployed.

24 of 24 checks passed:
- The default balance preset is in effect.
- Single-PNG upload works.
  - Non-PNG files get 415.
  - Oversize frames get 400.
  - Viewers get 403.
- 10 profiles were saved.
- Duels are paused without a relay; one-time pairing works.
- 10 characters appear after their first chat message, including the uploaded one.
- A viewer can only be in one duel (player_busy).
- 5 duels can run at once.
- Cooldowns work, and heal is used.
- All 5 duels completed.
  - The losers are knocked out and respawn.
  - Elo ended at 1012/988.
  - The rematch delay applies.
- When the relay drops, duels pause and cancel without scoring.
- The relay reconnects with its stored credential.
- Mods can turn duels off and on.
- State survives an overlay reload.

Fixed after looking at the OBS captures:
- With 5 duels at once, duelists piled into two clumps and their HP bars overlapped. Each duel now gets its own spot (`freeMeetX` in `public/overlay.js`).
- An uploaded character showed as a stock sprite for up to 30 s. The overlay now refetches the catalog as soon as it sees a new avatar ID.

After these fixes, `npm run test:all` passes all 8 stages.
