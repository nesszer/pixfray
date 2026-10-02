# mini-chat contracts

This file is for every lane that builds against the backend. If it disagrees with the code, the code
wins; report the difference to Lane A. Only the `nesszerra` channel is enabled. Any other channel in
`:channel` (including `miolafff`) returns 403.

## 1. Conventions

- JSON responses carry `Cache-Control: no-store`. Errors look like `{ "error": "<message>" }`.
  Game errors also include `reason` (a snake_case code, listed in section 6).
- Mutations (`POST`, `DELETE`, ...) must send `Origin` equal to the site origin, or they get 403.
  The one exception is `POST /api/eventsub`, which Twitch calls; its HMAC signature authenticates it.
- Request bodies must be a JSON object. Malformed JSON, `null` or an array returns 400; a body
  over the route's limit returns 413.
- Auth uses the `mini_session` cookie (HttpOnly), set by `/auth/callback`.
- Roles come from `GET /api/access/:channel`: `owner` (the nesszerra account), `moderator` (Helix
  moderator check) and `canManage = owner || moderator`.
- Unknown errors return 503 `{error:"Service unavailable; check owner diagnostics"}` and are
  logged for the developer page.

## 2. HTTP routes

| Method | Path | Auth | Request | Success response | Errors |
|---|---|---|---|---|---|
| GET | `/auth/login[?connect=1]` | none | none | 302 to Twitch | 503 when Twitch is not configured |
| GET | `/auth/callback` | none | Twitch `code` and `state` | 302 to `/`, sets the cookie | 400, 403 |
| POST | `/auth/logout` | cookie | none | clears the cookie | 403 when cross-origin |
| GET | `/api/session` | optional | none | `{user:{id,login,displayName}\|null, owner, configured, channels:["nesszerra"], productionEnabled:false}` | 503 when secrets are missing |
| GET | `/api/health` | none | none | `{ok:true, version, twitchConfigured, productionEnabled:false}` | |
| GET | `/api/access/:channel` | optional | none | `{owner, moderator, canManage, reason}` | 403 for a disabled channel |
| GET | `/api/state/:channel` | none | none | Snapshot (section 3) | 403, 405 |
| GET | `/api/leaderboard/:channel` | none | none | Up to 100 `Profile` rows, ordered by elo desc, then wins desc, then username | 403 |
| GET | `/api/catalog/:channel` | none | none | `[...static characters.json, ...custom entries]` (section 5) | 403 |
| GET | `/api/profile/:channel` | cookie | none | `Profile` or `null` | 401 |
| POST | `/api/profile/:channel` | cookie | `{avatar, color:"#rrggbb", defaultAbility:"strike"\|"heavy"\|"heal"}`, max 4000 bytes | `{profile, revision}` | 400 invalid field or unknown character, 401, 413 |
| GET | `/api/admin/:channel` | canManage | none | Snapshot plus `{chatStatus (section 4), history:[{version,config,actorId,actorName,at,note}] (newest first, 50 max; actorName is the Twitch display name at save time, empty for older rows), customUsage:{count,limit,bytes}, access:{owner,moderator,canManage,reason}}` | 401 signed out, 403 not a mod |
| POST | `/api/admin/:channel` | canManage | `{action, payload?}`, max 12000 bytes. Any `actorId` you send is replaced by the session user. | `{ok:true, reason, revision, ...}` | 400 / 403 / 404 / 409 with `{ok:false, reason, error}` |
| WS | `/api/live/:channel` | none | Upgrade | Read-only overlay socket (section 3) | 426 without an upgrade, 429 over 64 sockets |
| POST | `/api/eventsub` | Twitch EventSub HMAC signature (section 4) | Twitch webhook body, max 64 KB | verification: 200 `text/plain` challenge; notification, revocation, unknown types and duplicates: 204 | 400 missing headers or bad JSON, 403 bad signature or stale timestamp, 405, 413, 503 secrets missing or room failure (Twitch retries) |
| GET | `/api/assets/:channel/:id` | none | none | `image/png` atlas bytes | 404 |
| GET | `/api/assets/:channel` | canManage | none | `{items:[CatalogEntry & {bytes,createdBy,createdAt}], usage, limits}` | 401, 403 |
| POST | `/api/assets/:channel` | canManage | `{label:1-32 chars, mode:"single"\|"frames", fps:1-30, atlas:<base64 PNG, data: prefix allowed>, frames:[Frame], animations:{idle?,walk?,attack?,ko?,jump?,cheer?:[Frame]}}` | 201 `{ok:true, item:CatalogEntry, usage:{count,limit,bytes}}` | `{ok:false, reason, error}`: 400 `invalid_label`/`invalid_*`/`too_many_frames`/`frame_too_large`/`frame_out_of_bounds`/`atlas_dimensions`, 413 `atlas_too_large`, 415 `not_png`, 409 `custom_limit_reached`, 401, 403 |
| DELETE | `/api/assets/:channel/:id` | canManage | none | `{ok:true, id, usage}` | 404 `not_found`, 401, 403 |
| GET | `/api/dev/diagnostics` | owner | none | `{worker:{version,twitchConfigured,productionEnabled,deployedVersion}, room:{channel,revision,chat:{connected,lastSeen,status},chatStatus,paused,configVersion,players,openDuels,sockets:{live},errors,errorsBySource,lastError}, integrations:{github:{configured,missing[],repo,base,workflow}, cloudflare:{configured,missing[],versionMetadata}}, usage, codex}` | 401, 403 |
| GET, DELETE | `/api/dev/logs[?source=room\|worker&limit=1..100]` | owner | none | GET: error rows `[{id,at,source,message,context}]`, newest first. DELETE clears them. | 401, 403 |
| GET, POST | `/api/dev/settings` | owner | POST `{action:"config"\|"rollbackConfig", payload}` or `{action:"connectChat"\|"disconnectChat", takeover?:true}` | The same versioned config as `/api/admin` (history rows carry the owner's actorName); chat actions answer like the admin ones | 400, 403 `reconnect`, 409, 502 |
| GET, POST | `/api/dev/codex` | owner | POST `{authorized:bool, note?}` | `{authorized, note, updatedBy, updatedAt}`; off by default and only records the decision | 400 |
| GET | `/api/dev/usage`, `/api/dev/versions` | owner | none | Request usage and Worker versions from the Cloudflare API, or `{configured:false, error}` / `missing[]` when `CF_API_TOKEN`/`CF_ACCOUNT_ID` are unset | 401, 403 |
| GET/POST | `/api/dev/code/tree`, `code/file`, `code/save`, `code/pr`, `runs`, `deploy`, `promote`, `hotfix`, `rollback` | owner | See docs/LIVE_FIX.md | GitHub-backed flow | 501 `{reason:"github_not_configured", missing:[...]}` until `GITHUB_TOKEN`/`GITHUB_REPO` are set; 404 `unknown_route`, 405 `method_not_allowed` |

### Admin actions (`POST /api/admin/:channel`)

| action | payload | Effect |
|---|---|---|
| `config` | `{patch:{...}, baseVersion?, note?}` (`config` works as an alias of `patch`) | Validates the patch (section 7), increments `configVersion` and records a history row. A `baseVersion` that does not match returns 409 `config_version_conflict`. Running duels keep their old rules. |
| `rollbackConfig` | `{version}` | Applies the stored config as a new version, with note `rollback to vN`. A missing version returns 404 `config_version_not_found`. |
| `cancelDuel` | `{duelId}` | Cancels the duel without scoring it. If it was active, both players go back to maxHp. |
| `resetHealth` | none | Every active player goes to maxHp, and respawn is cleared. |
| `resetRank` | `{userId}` | Sets elo to initialElo and wins and losses to 0. Works for offline profiles too. |
| `resetAllRanks` | none | The same reset for every stored profile. |
| `resetRound` | none | Cancels open duels and sets `round` to 0. |
| `resetAll` | none | Clears players, duels and locks. Stored profiles stay. |
| `removePlayer` | `{userId}` | Removes the player from the arena and deletes the stored profile. |
| `connectChat` | none | Handled by the Worker, not the room. Ensures exactly one Twitch EventSub `channel.chat.message` webhook for this site (section 4) and records it in the room. Returns `{ok, reason, revision, chatStatus}`. 403 `{error, reconnect:"/auth/login?connect=1"}` when Twitch reports missing authorization; 409 `{reconnect}` when the broadcaster id is unknown; 409 `{error, connectedElsewhere}` when another site holds the chat subscription (retry with `takeover:true` to move it here, section 4); 502 when Twitch fails. |
| `disconnectChat` | none | Deletes the subscription at Twitch, marks chat disconnected, pauses duels and cancels open ones (`chat_disconnected`). |

## 3. Overlay socket `/api/live/:channel`

The server sends a snapshot as soon as the socket opens and after every visible change. The client
sends nothing; any client message closes the socket with 1008. Reconnect with backoff, and use
`GET /api/state/:channel` as the fallback.

```
Snapshot = {
  type:"snapshot", channel, revision:int, paused:bool,   // paused = chat not connected or config.enabled false
  chat:{connected:bool, lastSeen:ms, status}, config:Config, configVersion:int, round:int,
  players:Player[], duels:Duel[], events:Event[],         // events: the last 50, oldest first
  serverNow:ms                                            // server clock when sent
}
Player = {userId, username, displayName, avatar, color, defaultAbility, hp, elo, wins, losses,
          lastSeen, registered:bool, respawnAt:ms}         // respawnAt > now means KO'd
Duel   = {id, a, b, status:"pending"|"active"|"completed"|"cancelled"|"expired"|"declined",
          createdAt, expiresAt, startedAt, lastActionAt, hp:{[userId]:int}, rules:{maxHp,
          sharedCooldownMs, abilities}, cooldowns:{[userId]:{sharedUntil, strikeUntil, heavyUntil, healUntil}},
          round, winnerId, ratings:{[userId]:{before,after,delta}}, cancelReason, endedAt}
Event  = {id:string(revision), type, at:ms, ...fields}
```

Deduplicate events by `id`. All `ms` times are server clock. `public/arena-client.js` shifts `event.at`,
`event.respawnAt`, `player.respawnAt` and `chat.lastSeen` by `serverNow − Date.now()` before the overlay
sees them, so a streaming PC whose clock is off still plays fresh events (the overlay drops events
older than 10 s).

Event types and their fields:

| type | fields |
|---|---|
| `challenge_created` | duelId, a, b, expiresAt |
| `challenge_declined` | duelId, declinedBy |
| `challenge_expired` | duelId, a, b |
| `duel_started` | duelId, a, b, round, hp |
| `duel_action` | duelId, userId, targetId (the actor for heal), ability, amount, hp. Also sent for the final blow. A quick-duel roll adds die (1-6) and one of miss, crit or counter (userId is then the defender who counters), and finisher on the last blow. |
| `duel_completed` | duelId, winnerId, loserId, round, respawnAt, hp, ratings. Quick duels may add flawless (ratings of the winner then include bonus) and decision (`hp` or `sudden_death`). |
| `duel_cancelled` | duelId, a, b, reason (`inactivity`, `chat_disconnected`, `duels_disabled`, `moderator_cancelled`, `moderator_reset`, `player_removed`), wasActive |
| `player_respawned` | userId |
| `player_seen`, `profile_saved` | userId |
| `command_seen` | userId, command |
| `config_updated` | actorId, configVersion, config |
| `health_reset`, `all_ranks_reset`, `game_reset`, `round_reset` | actorId |
| `rank_reset`, `player_removed` | actorId, userId |
| `chat_connected` | none |
| `chat_disconnected` | reason (`disconnected` for Disconnect chat, or the Twitch status such as `authorization_revoked`, `user_removed`, `subscription_missing`) |
| `command_rejected` | userId, command, reason, retryAt? (a chat command that did not apply; Twitch gets no reply) |

## 4. Chat source: Twitch EventSub webhook `POST /api/eventsub`

Chat reaches the game only through one Twitch EventSub subscription, delivered by webhook to the
Worker. There is no local process, no socket to Twitch and no heartbeat: everything runs on
Cloudflare. Each chat message costs 1 Worker request and 1 Durable Object request.

Subscription (created by `connectChat` with an app access token from `client_credentials`, cached
sealed in AuthStore as `app-token:twitch`):
```
{type:"channel.chat.message", version:"1",
 condition:{broadcaster_user_id:<nesszerra id>, user_id:<nesszerra id>},
 transport:{method:"webhook", callback:"${PUBLIC_ORIGIN}/api/eventsub", secret:<derived>}}
```
- The broadcaster id is `OWNER_TWITCH_ID` or the `owner:nesszerra` record written at sign-in.
- Twitch requires nesszerra to have granted `user:read:chat` and `user:bot` (plus `channel:bot`)
  to this app. `/auth/login?connect=1` asks for `moderation:read user:read:chat user:bot
  channel:bot` and refuses a grant that lacks any of them.
- `connectChat` lists this app's `channel.chat.message` subscriptions, keeps one enabled v1
  webhook to this callback with the condition above, and deletes every other one to this callback.
- Twitch allows one subscription per type and condition, whatever the callback. Both sites share
  one Twitch app, so only one site at a time receives chat. A live (`enabled` or verification
  pending) subscription with the same condition on another callback makes `connectChat` answer
  409 `{error, connectedElsewhere:<origin>}`; `{action:"connectChat", takeover:true}` deletes it
  and creates ours. Dead ones (failed, revoked) with the same condition are always deleted. A Helix
  409 on create answers the same 409 with `connectedElsewhere:"another site"`.
- The callback must be https, so a real subscription is possible only on a deployed site.
- The room re-checks the subscription at Twitch once an hour (DO alarm), and every 3 minutes
  while it is still awaiting webhook verification. Only a definite answer (missing, or a status
  other than `enabled` / `webhook_callback_verification_pending`) disconnects chat, with that
  status (e.g. `webhook_callback_verification_failed`) as the reason; a failed Helix call changes
  nothing. A pending subscription that Helix reports `enabled` becomes connected.

Request checks, in order:
1. Headers `Twitch-Eventsub-Message-Id`, `-Message-Timestamp`, `-Message-Signature`,
   `-Message-Type` and `-Subscription-Type` must be present (400). The body is read once, max 64 KB
   (413). Only the fields the room reads are forwarded to it (chatter id/login/name, color,
   message_id, message.text cut to 512 chars, broadcaster login); fragments, badges, reply and
   cheer are dropped, so the room payload stays a few hundred bytes. A room 4xx for a validly
   signed message is acknowledged with 204 (no Twitch retry loop); only a room 5xx answers 503.
2. Signature: `sha256=` + hex(HMAC-SHA256(secret, id + timestamp + raw body)), compared in
   constant time (403). The secret is derived, not stored:
   hex(HMAC-SHA256(AUTH_SECRET, "mini-chat:eventsub:v1")).
3. Timestamp: at most 10 minutes old and at most 1 minute in the future (403).
4. Message ids are deduplicated in the room for about 10 minutes; a duplicate returns 204 and
   changes nothing. Commands are also deduplicated durably by the chat `message_id`.

Message types:
- `webhook_callback_verification`: answers 200 `text/plain` with `challenge`. Chat counts as
  connected when the subscription is `enabled` or its verification arrived (in either order).
- `notification` for `channel.chat.message`: routed by `event.broadcaster_user_login`; other
  channels are ignored. The room requires `subscription.id` to match the connected subscription.
  Every message refreshes the chatter's presence (at most once per 30 s, with the Twitch name color
  for unregistered chatters). Text matching the command regex below also runs as a command; a
  rejected command is logged as a `command_rejected` event. Twitch gets no reply.
- `revocation`: if the id matches, chat is disconnected with the Twitch status as the reason;
  duels pause and open duels are cancelled. Returns 204.
- Anything else returns 204 and is ignored.

A command older than 60 s or more than 10 s in the future (by the message timestamp) is rejected
as `stale_command`.

Status for admins (`chatStatus` in `GET /api/admin/:channel`, `/api/dev/diagnostics` and the
chat action responses):
```
{connected, status, subscriptionId, createdAt, lastNotificationAt, lastRevocationReason, checkedAt}
```

Command grammar:
```
/^!(duel|challenge|accept|decline|attack|strike|heavy|heal)(?:\s+(@?[a-z0-9_]{1,25}))?\s*$/i
```
`challenge` is an alias of `duel`, and duel needs a target. `attack` uses the player's
`defaultAbility`. The optional target is allowed on every command.

Local testing: `cf dev` started with `MINI_LOCAL_TEST=1` (scripts/test-all.mjs does this) makes
`connectChat` record a `local-<16 hex>` subscription without calling Twitch, only when
`PUBLIC_ORIGIN` and the request host are loopback. `cloudflare.config.ts` refuses to build or
deploy with that flag. Tests sign their own webhook bodies with the derived secret.

## 5. Characters and catalog

```
CatalogEntry = {id, label, url, frames:[Frame], fps, anchor:{x:0.5,y:1}, license, source,
                animations:{idle?:[Frame], walk?:[Frame], attack?:[Frame], ko?:[Frame],
                            jump?:[Frame], cheer?:[Frame]}, custom?:true,
                mode?:"single"|"frames", combatFallback?:"effects"}   // custom uploads only
Frame = {x, y, w, h}   // pixel rectangle in the atlas at `url`
```

Fallbacks: `idle` and `walk` fall back to `frames`. `combatFallback:"effects"` marks a custom upload
without attack frames; `mode:"single"` (one PNG) is animated by the engine with bob and squash. If `attack` or `ko` is missing, the overlay
plays an effect (flash, shake, fade) over `idle`. Static characters live in
`public/assets/characters.json`; every asset must be listed in `ASSET_LICENSES.md`.

Custom characters:
- Ids match `^c-[a-z0-9-]{1,40}$`. `url` is `/api/assets/<channel>/<id>`.
- Limits (`UPLOAD_LIMITS`): PNG only, at most 24 frames, frames up to 128x128, an atlas of at most
  1,572,864 bytes, and at most 24 characters per channel.
- Stored in the room table `custom_characters(id, meta JSON without id/url, atlas BLOB, bytes,
  created_by, created_at)`.

## 6. Game rules (game.js)

- A duel starts with `!duel @user`. The target must `!accept` within `challengeTimeoutMs`, or the
  challenge expires. Either side may `!decline`.
- A player can be in at most 1 open duel, and the channel holds at most `maxDuels` open duels.
- Abilities: `strike` and `heavy` deal `damage`; `heal` restores `amount`, capped at maxHp. Each
  ability has its own `cooldownMs`, plus a shared cooldown of `sharedCooldownMs` after any action.
- The first player to reach 0 hp loses. The winner returns to maxHp. The loser is KO'd until
  `respawnAt = now + respawnMs`. Elo uses K=`eloK` from `initialElo`. The same pair cannot duel again
  for `rematchDelayMs`.
- A quick duel (StreamElements `!fight`) is rolled at once: turns alternate, challenger first; a d6 per swing gives a crit of 50% maxHp on 6, a hit of 34% on 5, a miss on 3-4 and a defender counter of 34% on 1-2. After 12 rolls more hp wins; equal hp goes to sudden death (the next blow wins). A winner at full hp gets +3 Elo (flawless).
- An active duel with no action for `inactivityMs` is cancelled without scoring. Cancelled duels
  return both players to maxHp.
- Ranked play needs a saved profile (`ranked_sign_in_required`).
- Reason codes: `active_player_cap`, `challenge_not_found`, `channel_full`,
  `config_version_conflict`, `config_version_not_found`, `cooldown` (+`retryAt`), `duel_not_found`,
  `duels_disabled`, `duplicate`, `invalid_ability`, `invalid_config*`, `invalid_event`,
  `missing_message_id`, `not_game_command`, `not_in_active_duel`, `not_in_duel`, `player_busy`,
  `profile_not_found`, `ranked_sign_in_required`, `chat_offline`, `rematch_cooldown` (+`retryAt`),
  `respawning`, `self_duel`, `stale_command`, `target_not_found`, `unknown_subscription`,
  `target_required`, `unauthorized`, `unknown_admin_action`, `unknown_config_field`, `wrong_opponent`.

## 7. Config and balance

| field | default | range |
|---|---|---|
| enabled | true | boolean |
| maxHp | 100 | 1 to 1000 |
| maxDuels | 5 | 1 to 5 |
| challengeTimeoutMs | 30000 | 5000 to 300000 |
| inactivityMs | 60000 | 10000 to 600000 |
| respawnMs | 3000 | 0 to 60000 |
| rematchDelayMs | 30000 | 0 to 600000 |
| sharedCooldownMs | 1000 | 250 to 60000 |
| initialElo | 1000 | 0 to 10000 |
| eloK | 24 | 1 to 100 |
| abilities.strike | `{damage:10, cooldownMs:3000}` | damage 1 to 1000, cooldownMs 250 to 600000 |
| abilities.heavy | `{damage:25, cooldownMs:8000}` | same as strike |
| abilities.heal | `{amount:15, cooldownMs:10000}` | amount 1 to 1000, cooldownMs 250 to 600000 |

Values must be integers (except `enabled`). Unknown fields are rejected, except `relayLeaseMs`,
which older history versions still carry; it is ignored so they can be rolled back. A patch may contain any
subset of fields. Versioning works like this:
- `configVersion` starts at 1. Each successful change increments it and stores a history row, and
  the last 200 versions are kept.
- The dashboard should send `baseVersion` and, on a 409, reload and show the conflict.

## 8. Lane modules and file ownership

| Lane | Owns | Contract |
|---|---|---|
| A (backend core) | `server/worker.js`, `server/channel.js`, `server/auth.js`, `server/game.js`, `server/eventsub.js`, `cloudflare.config.ts`, `tests/` (the core tests) | This file |
| B (UI) | `index.html`, `admin/index.html`, `src/`, `public/*.js`, the `vite.config.js` inputs | Sections 2, 3, 5, 7 |
| D (uploads) | `server/uploads.js`, `public/assets/characters.json`, assets, `ASSET_LICENSES.md` | Section 5 and the signatures below |
| E (developer) | `server/developer.js`, `admin/dev/index.html` | The signatures below |

Keep these signatures; worker.js and channel.js call them.

```js
// server/uploads.js (Lane D)
export const UPLOAD_LIMITS, CUSTOM_ID;
export async function handleUploads(request, env, c)
//   c = {user, owner, channel, id, url, bodyJson(request, limit), access():Promise<roles>, roomFetch(path, init?)}
export async function handleRoomAssets(room, request, {path, channel})  // DO: GET /catalog, /asset, /asset/:id
export function ensureUploadSchema(sql)                                // called from the ChannelRoom constructor
export function customUsage(room)                                      // -> {count, limit, bytes}

// public/upload.js (Lane D, browser): the admin page mounts it
export async function mountUpload(root, {channel, usage, limits, items, refresh})  // -> {destroy()}

// server/developer.js (Lane E)
export async function handleDeveloper(request, env, c)
//   c = {user, owner, url, path, bodyJson, roomFetch(channel, path, init?), chatAction(channel, action), waitUntil(promise)}
export async function handleRoomDeveloper(room, request, {path, channel}) // DO: /dev/diagnostics, /dev/logs, POST /dev/log
export function ensureDeveloperSchema(sql)
export function logRoomError(room, error, context)                     // never throws
export async function logWorkerError(env, error, context)              // never throws
```

`roomFetch` adds the internal secret and channel headers. `room.ctx.storage.sql` is the DO's SQLite.
Use SQLite DOs only, and nothing outside Cloudflare Free.

## 9. Tests and build

```
npm run test:unit          # node --import ./tests/register.mjs --test "tests/*.test.mjs"
npx cf build               # production build ("Build complete"; ignore the Docker error)
npx cf build --mode test
npx cf dev                 # local only; reads .dev.vars. Never deploy from a lane.
npm run test:all           # everything below, in order (scripts/test-all.mjs)
```

- `MINI_PORT` (default 5173) and `MINI_PERSIST` (a local state folder) are read by `vite.config.js`, so
  `MINI_PORT=5199 MINI_PERSIST=.cloudflare/e2e-state npx cf dev` runs beside another dev server.
- `tests/seed-local.mjs` writes test-only sessions (owner 900001 nesszerra, alice_e2e, bob_e2e,
  carol_e2e) into that local AuthStore while no server holds it.
- Browser tests take `MINI_BASE_URL`; `tests/e2e-local.mjs` sends signed EventSub webhooks to the
  real Worker (it needs `MINI_AUTH_SECRET`, which scripts/test-all.mjs reads from `.dev.vars`
  without printing it) and drives the overlay, dashboard, admin and dev pages.
- The overlay draws the arena only with `arena=1` (the OBS URL from the setup page adds it).
- Bindings: ASSETS, ROOMS, AUTH, `CF_VERSION_METADATA` (version metadata), `PUBLIC_ORIGIN`
  (the EventSub callback and OAuth redirect origin) and the secrets
  `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `AUTH_SECRET`, `INTERNAL_SECRET`. `GITHUB_TOKEN`,
  `GITHUB_REPO`, `CF_API_TOKEN` and `CF_ACCOUNT_ID` are optional secrets set with
  `wrangler secret put` (docs/LIVE_FIX.md); they are not declared, because declared secrets are
  required at deploy time.
