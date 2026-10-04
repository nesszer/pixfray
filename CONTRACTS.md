# mini-chat contracts

This file is for every lane that builds against the backend. If it disagrees with the code, the code
wins; report the difference to Lane A. `nesszerra` and `miolafff` are built in and always on. Other
channels are added by invite (section 2a). A channel that isn't set up returns 403
`{error, off:"not_enabled"}`; a channel that is turned off returns 403 `{error, off:"paused"}` on
every route except `access`, `admin`, `leaderboard`, `catalog` and `assets`, so its streamer and mods
can still sign in and turn it back on.

## 1. Conventions

- JSON responses carry `Cache-Control: no-store`. Errors look like `{ "error": "<message>" }`.
  Game errors also include `reason` (a snake_case code, listed in section 6).
- Mutations (`POST`, `DELETE`, ...) must send `Origin` equal to the site origin, or they get 403.
  The one exception is `POST /api/eventsub`, which Twitch calls; its HMAC signature authenticates it.
- Request bodies must be a JSON object. Malformed JSON, `null` or an array returns 400; a body
  over the route's limit returns 413.
- Auth uses the `mini_session` cookie (HttpOnly), set by `/auth/callback`.
- Roles come from `GET /api/access/:channel`: `owner` (the nesszerra account: its Twitch id must equal
  `OWNER_TWITCH_ID` when that binding is set, otherwise the `owner:nesszerra` record), `broadcaster` (the
  channel's own account), `moderator` (Helix moderator check, needs the stored broadcaster token) and
  `canManage = owner || broadcaster || moderator`.
- Unknown errors return 503 `{error:"Service unavailable; check owner diagnostics"}` and are
  logged for the developer page.

## 2. HTTP routes

| Method | Path | Auth | Request | Success response | Errors |
|---|---|---|---|---|---|
| GET | `/auth/login[?channel=x][&connect=1\|mods][&next=/admin/\|/admin/dev/]` | none | none | 302 to Twitch. `connect=1` (nesszerra only) asks for the EventSub chat scopes; `connect=mods` asks the channel's broadcaster for `moderation:read` and comes back to `/admin/?channel=x&mods=connected\|denied\|wrong_account#chat` | 403 channel not set up, 503 when Twitch is not configured |
| GET | `/auth/login?invite=<token>[&mods=0]` | none | none | 302 to Twitch, asking for `moderation:read` unless `mods=0`. A bad invite goes to `/start/?invite=..&error=invalid\|expired\|used` instead | 503 |
| GET | `/auth/callback` | none | Twitch `code` and `state` | 302 to `/` (or `next`), sets the cookie. An invite signup turns the channel on, stores the broadcaster token when the scope was granted, and lands on `/admin/?channel=<login>&signed_in=1#chat`. A failed signup goes back to `/start/?invite=..&error=wrong_account\|full\|denied\|failed` with no session | 400, 403 |
| GET | `/api/invite/:token` | none | 32 hex chars | `{status:"valid"\|"used"\|"expired"\|"invalid", login?}` | 404 malformed token |
| POST | `/auth/logout` | cookie | none | clears the cookie | 403 when cross-origin |
| GET | `/api/session` | optional | none | `{user:{id,login,displayName}\|null, owner, configured, channels:["nesszerra","miolafff"] (the built-ins), productionEnabled:{live, streamId?}` (`live` true, false or null}`. `productionEnabled` is a constant `false` left from the first rollout, when production stayed closed until the broadcaster was onboarded. Nothing reads it; use `channelState` instead. | 503 when secrets are missing |
| GET | `/api/channels` | none | none | `{channels:[login,...]}`: the built-ins first, then the enabled (not paused) registry channels in sign-up order. Cached 60 s per isolate. The viewer page at a bare `/` (no `?channel=`) shows "Which stream are you watching?" with one button per channel; every link the site, sign-in and `!minichat` hand out carries `?channel=` so a fighter is never saved to the wrong channel by default | |
| GET | `/api/health` | none | none | `{ok:true, version, twitchConfigured, productionEnabled:{live, streamId?}` (`live` true, false or null}` (same constant) | |
| GET | `/api/access/:channel` | optional | none | `{owner, broadcaster, moderator, canManage, reason}` | 403 for a channel that isn't set up |
| GET | `/api/state/:channel` | none | none | Snapshot (section 3) | 403, 405 |
| GET | `/api/leaderboard/:channel` | none | none | Up to 100 `Profile` rows, ordered by elo desc, then wins desc, then username (quick-duel results still on stream are not shown yet; see Game rules) | 403 |
| GET | `/api/looks/:channel?u=login1,login2` | none | at most 20 logins | `{login:{avatar, color, hat, displayName, elo}}` for viewers with a saved fighter only. The overlay uses it for chat-only viewers, batched every 2 s; a saved look is cached 5 min, "no saved fighter" 1 min, and a failed lookup (such as a 429) is retried after 10 s, not cached. | 403 |
| GET | `/api/se/:channel/:action?k=..&id=..&u=..&d=..&t=..&m=..` | the channel's StreamElements key `k` | `action` is `challenge`, `accept`, `decline`, `rematch` (challenges the sender's last finished-duel opponent), `top` (default name `!ranks`), `elo`, `help` (default name `!minichat`) or `checkin` (once per stream while the channel is live; see Game rules). The first command with the right key makes StreamElements the chat source (and deletes a Twitch EventSub subscription), unless a mod used Disconnect chat. Each action's last arrival is recorded (at most once a minute) for the admin badges; New key clears them. The Worker checks the request before any Durable Object call ("StreamElements route checks" below). | always 200 `text/plain`: the one-line chat reply for the bot to post (empty for a repeated message id) | 405 not GET, 404 path doesn't match or a well-formed key on a channel that isn't set up, 429 from the edge rate limit, 503 `INTERNAL_SECRET` missing |
| GET | `/api/catalog/:channel` | none | none | `[...static characters.json, ...custom entries]` (section 5) | 403 |
| GET | `/api/profile/:channel` | cookie | none | `Profile` or `null` | 401 |
| POST | `/api/profile/:channel` | cookie | `{avatar, color:"#rrggbb", defaultAbility:"strike"\|"heavy"\|"heal", stats?:{power,guard,luck}, hat?}`, max 4000 bytes. `stats` are checked against the points from saved wins plus check-ins, and `hat` against the saved wins (server/upgrades.js); a stats change while the fighter is in a duel is refused (`in_duel`). | `{profile, revision}` | 400 invalid field or unknown character, 401, 413 |
| GET | `/api/admin/:channel` | canManage | none | Snapshot plus `{chatStatus (section 4), history:[{version,config,actorId,actorName,at,note}] (newest first, 50 max; actorName is the Twitch display name at save time, empty for older rows), customUsage:{count,limit,bytes}, access:{owner,moderator,canManage,reason}, overlays (open role=overlay sockets), modsReady (broadcaster token stored), modsLapsed (see 2a), seOnly (test site: chat comes from StreamElements only), channelState ("builtin"\|"on"\|"paused"), streamelements:{key,names,commands,seen:{action:ms},duelModuleOff,lastCommandAt,rejectedAt,timerText}}` | 401 signed out, 403 not a mod |
| POST | `/api/admin/:channel` | canManage | `{action, payload?}`, max 12000 bytes. Any `actorId` you send is replaced by the session user. | `{ok:true, reason, revision, ...}` | 400 / 403 / 404 / 409 with `{ok:{live, streamId?}` (`live` true, false or null, reason, error}` |
| WS | `/api/live/:channel[?role=overlay]` | none | Upgrade | Read-only overlay socket (section 3). OBS overlays send `role=overlay` so the admin setup checklist can count them. | 426 without an upgrade, 429 over 64 sockets |
| POST | `/api/eventsub` | Twitch EventSub HMAC signature (section 4) | Twitch webhook body, max 64 KB | verification: 200 `text/plain` challenge; notification, revocation, unknown types and duplicates: 204 | 400 missing headers or bad JSON, 403 bad signature or stale timestamp, 405, 413, 503 secrets missing or room failure (Twitch retries) |
| GET | `/api/assets/:channel/:id` | none | none | `image/png` atlas bytes | 404 |
| GET | `/api/assets/:channel` | canManage | none | `{items:[CatalogEntry & {bytes,createdBy,createdAt}], usage, limits}` | 401, 403 |
| POST | `/api/assets/:channel` | canManage | `{label:1-32 chars, mode:"single"\|"frames", fps:1-30, atlas:<base64 PNG, data: prefix allowed>, frames:[Frame], animations:{idle?,walk?,attack?,ko?,jump?,cheer?:[Frame]}}` | 201 `{ok:true, item:CatalogEntry, usage:{count,limit,bytes}}` | `{ok:{live, streamId?}` (`live` true, false or null, reason, error}`: 400 `invalid_label`/`invalid_*`/`too_many_frames`/`frame_too_large`/`frame_out_of_bounds`/`atlas_dimensions`, 413 `atlas_too_large`, 415 `not_png`, 409 `custom_limit_reached`, 401, 403 |
| DELETE | `/api/assets/:channel/:id` | canManage | none | `{ok:true, id, usage}` | 404 `not_found`, 401, 403 |
| GET | `/api/dev/diagnostics` | owner | none | `{worker:{version,twitchConfigured,productionEnabled,deployedVersion}, room:{channel,revision,chat:{connected,lastSeen,status},chatStatus,paused,configVersion,players,openDuels,sockets:{live},errors,errorsBySource,lastError}, integrations:{github:{configured,missing[],repo,base,workflow}, cloudflare:{configured,missing[],versionMetadata}}, usage}`; `room` also has `seLastCommandAt` (0 until a StreamElements command arrives with the current key); `errors` and `lastError` count only `room` and `worker` entries, because command lines and warnings (also listed in `errorsBySource`) are not errors | 401, 403 |
| GET, DELETE | `/api/dev/logs[?source=room\|worker&limit=1..100]` | owner | none | GET: error rows `[{id,at,source,message,context}]`, newest first. DELETE clears them. | 401, 403 |
| GET, POST | `/api/dev/settings` | owner | POST `{action:"config"\|"rollbackConfig", payload}` or `{action:"connectChat"\|"disconnectChat", takeover?:true}` | The same versioned config as `/api/admin` (history rows carry the owner's actorName); chat actions answer like the admin ones | 400, 403 `reconnect`, 409, 502 |
| GET, POST | `/api/dev/channels` | owner | POST `{action:"invite", login}`, `{action:"revoke", token}`, `{action:"pause"\|"resume", login}` | `{builtin:[login], max, channels:[{login,enabledAt,pausedAt}], invites:[{token,login,createdAt,usedAt,status}], progressBatch:40}`. GET no longer returns setup progress; the owner page reads it from `/api/dev/progress` in batches of `progressBatch` after the list renders. `invite` adds `{token, link}` | 400 `bad_login`/`invalid`/`builtin` (pause), 404 `not_found`, 409 `exists`/`builtin` (invite), 403 `full` (200 channels on) |
| GET | `/api/dev/progress?logins=a,b,c` | owner | `logins`: comma-separated, lowercased and de-duplicated, at most 40 (one room read each, within the Free plan's 50 subrequests per request). Each must be a built-in or a turned-on channel (a paused one is `unknown_channel`). POST gets 405. | `{progress:{login:{overlays,source,commandsWorking,commands,duelCommands,duelModuleOff,lastCommandAt,rejectedAt,lastChatAt,players}}}`. `source` is `""` while chat isn't connected. A login whose room read fails is left out. Read only: it never creates a StreamElements key. | 400 `logins_required`, 400 `too_many_logins` `{max:40}`, 400 `unknown_channel` `{invalid:[...]}`, 401, 403 |
| GET | `/api/dev/export?channel=<login>` or `?registry=1` | owner | none | A JSON download (`Content-Disposition: attachment`). `channel`: `mini-chat-<login>-<YYYY-MM-DD>.json` = `{format:"mini-chat-export", version:1, exportedAt, kind:"channel", channel, status:"builtin"\|"on"\|"paused", counts:{profiles,configVersions,customCharacters}, profiles[], config, configVersion, configHistory[], customCharacters[], streamelements:{commandNames}}`. Profiles carry elo, wins, losses, looks, upgrade stats, hat and `lastOpponentId`. `customCharacters` holds metadata only, no atlas images. `registry`: `mini-chat-channels-<date>.json` = `{format, version, exportedAt, kind:"registry", builtin, channels:[{id,login,enabledAt,pausedAt}], invites:[{login,createdAt,usedAt,by,status}]}`. Neither includes StreamElements keys, Twitch tokens or invite tokens. A paused channel still exports. The Worker reads one room through its internal, read-only `GET /dev/export` (`server/developer.js`). | 400 `export_target_required`, 404 `unknown_channel`, 502 `room_unavailable`, 401, 403 |
| GET | `/api/dev/usage`, `/api/dev/versions` | owner | none | Request usage and Worker versions from the Cloudflare API, or `{configured:{live, streamId?}` (`live` true, false or null, error}` / `missing[]` when `CF_API_TOKEN`/`CF_ACCOUNT_ID` are unset | 401, 403 |
| GET/POST | `/api/dev/code/tree`, `code/file`, `code/save`, `code/pr`, `runs`, `deploy`, `promote`, `hotfix`, `rollback` | owner | See docs/LIVE_FIX.md | GitHub-backed flow | 501 `{reason:"github_not_configured", missing:[...]}` until `GITHUB_TOKEN`/`GITHUB_REPO` are set; 404 `unknown_route`, 405 `method_not_allowed` |

### StreamElements route checks (`/api/se/...`)

`handleStreamElements` (server/streamelements.js) answers these before any room is called, in order:
1. Method must be GET (405).
2. The path must match `/api/se/<channel>/<action>` (404 "Unknown command").
3. The action must be one of the eight above. Anything else (an old `!attack` command, say) answers 200 "Lost in the arena? Type !minichat".
4. The key `k` must be present and at most 128 characters, or the reply is 200 "Mini Chat: missing key. Copy the commands again from the admin page."
5. The key must match `/^[a-f0-9]{48}$/`, or 200 "Mini Chat: wrong key. Copy the commands again from the admin page."
6. A refused (channel, key) pair is answered with the same wrong-key text from a per-isolate cache for 60 s, with no Durable Object request. The first refusal still reaches the room, which records `rejected_at` for the admin badge. A pair enters the cache when the room answers 403 with a reply. The cache holds 2000 pairs.
7. Channel state: paused answers 200 "Mini Chat is off on this channel right now."; not set up answers 404.
8. Then the room checks the key and runs the command.

Steps 3 to 5 come before the channel lookup, so an unknown channel with a bad action or a malformed or missing key gets the 200 text, not 404. A well-formed key on an unknown channel is still 404.

Edge rate limit (Cloudflare WAF, zone `miolaf.xyz`, so it covers prod and `test.chat`): ruleset "Mini Chat rate limit" (id `c14d229ed8534be9b8d10168bcfc664d`), rule id `c7ecb06b07954bf6b2207c726dab6a1f` (ruleset version 2, 2026-10-03). Expression `starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/auth/")`, 20 requests per 10 s per IP and colo, then block for 10 s, so one IP can make at most about 86,000 Worker requests a day (the free quota is 100,000). The Free plan allows only this one rule, 10 s windows and 10 s blocks. StreamElements' servers share IPs across channels, so many busy channels at once could hit the limit; their commands then get no reply for 10 s. The first version (only `/api/se/`, 100 per 10 s) is saved in `work/ratelimit-backup-2026-10-03.json`. It lives in Cloudflare, not in this repo. To undo it, put the ruleset for phase `http_ratelimit` with an empty rules list.

Security: StreamElements passes the viewer's id and login in the query (`id=$(sender.twitchid)`, `u=$(sender.name)`), so anyone who holds a channel's key can send commands as any viewer of that channel. The key is the only secret. Keep the admin page's key off stream, and press New key if it leaks (docs/STREAMER_SETUP.md).

### 2a. Channel registry (server/channels.js)

Built-in channels come from `CHANNELS` in `server/auth.js`. Invited channels live in the AuthStore
Durable Object:

- `invite:<token>` = `{login, createdAt, by, usedAt?}`. The token is 32 hex chars. An invite is
  single use, works for 7 days, only for the Twitch account it names, and is kept 30 days for the
  owner's list.
- `channel:<login>` = `{id, login, enabledAt, pausedAt?}`. At most 200 channels can be on; resuming
  a channel counts against the cap too.
- AuthStore `GET /list?key=channel:|invite:` returns `[{key, value}]` for one prefix (500 max).
- `channelState(env, ch)` is cached per isolate (60 s for a hit, 10 s for a miss), so pausing reaches
  every isolate within about a minute. EventSub and `/api/session` still use the built-ins only;
  invited channels use StreamElements.
- `modsconnected:<login>` = `{at}`. Written when mod access is connected (`connect=mods`, an invite signup that grants `moderation:read`, or `connect=1`), and also by an admin page view that finds a stored token without one. Expires after 20 years (the AuthStore accepts expiries up to 21 years for `channel:` and `modsconnected:` keys, 100 days for everything else).
- `broadcaster:<login>` = the sealed Twitch token plus `touched` (ms). It is kept 90 days from its last use: every save refreshes the expiry, the hourly token validation re-saves it, and an admin page view re-saves it when `touched` is more than 7 days old. A 401 from Twitch renews the access token with the stored refresh token. If the record expires or the refresh fails, mod checks stop (`modsReady:{live, streamId?}` (`live` true, false or null`).
- `GET /api/admin/:channel` adds `modsReady` (the `broadcaster:<login>` record exists) and `modsLapsed` (`modsconnected:<login>` exists but `broadcaster:<login>` is gone). They are never both true. `modsLapsed` makes the admin page show "Expired" and "Reconnect mod access" instead of "Connect mod access" in Stream setup.
- `OWNER_TWITCH_ID` is a text binding, nesszerra's public Twitch id `445610108`, declared for prod and test in `cloudflare.config.ts`. When it is set, `isOwner` compares the session user's id to it and ignores the `owner:nesszerra` record (which expires 90 days after the last sign-in). It is not declared when `cf dev` runs with `MINI_LOCAL_TEST=1` (the test server), where seeded sessions use owner id 900001 and the `owner:nesszerra` record decides. A plain `cf dev` without that flag does declare it.
- An overlay on a paused or unknown channel draws nothing and reloads every 5 minutes. One that was
  already open when the channel was paused keeps running until OBS reloads it. StreamElements
  commands on a paused channel answer "Mini Chat is off on this channel right now."

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
| `disconnectChat` | none | Deletes the subscription at Twitch, marks chat disconnected, pauses duels and cancels open ones (`chat_disconnected`). StreamElements commands don't reconnect a channel turned off this way. |
| `pauseChannel` / `resumeChannel` | none | Handled by the Worker; the broadcaster or the owner only (403 for mods). Turns an invited channel off or back on (`channel:<login>.pausedAt`). Fighters, ranks and settings are kept. Other isolates notice within a minute. 400 for a built-in channel. Returns `{ok:true, channelState}`. |
| `setDuelModuleOff` | `{value:boolean}` (top level) | Handled by the Worker. Saves the setup checklist tick "StreamElements Duel module turned off". New key keeps it. |

## 3. Overlay socket `/api/live/:channel`

The server sends a snapshot as soon as the socket opens and after every visible change. The client
sends nothing; any client message closes the socket with 1008. Reconnect with backoff, and use
`GET /api/state/:channel` as the fallback.

```
Snapshot = {
  type:"snapshot", channel, revision:int, paused:bool,   // paused = chat not connected or config.enabled {live, streamId?}` (`live` true, false or null
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
/^!(duel|challenge|rematch|accept|fight|decline|attack|strike|heavy|heal)(?:\s+(@?[a-z0-9_]{1,25}))?\s*$/i
```
`challenge` is an alias of `duel`, `fight` is an alias of `accept`, and duel needs a target. `attack` uses the player's
`defaultAbility`. The optional target is allowed on every command. `rematch` ignores it and challenges the opponent of the sender's last finished duel (`lastOpponentId` on the player, saved as `profiles.last_opponent`), with the same rules as a challenge; with no such duel the reason is `no_previous_opponent`. A rematch answered by `!rematch` is a mutual challenge, so the duel starts. If someone has challenged the sender and is waiting for an answer, `!rematch` answers that challenge instead, so it works even when the challenger was not the sender's last opponent.

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

- A duel starts with `!duel @user` (or `!challenge`). The target must `!accept` (or `!fight`) within `challengeTimeoutMs`, or the
  challenge expires. Either side may `!decline`. Challenging someone who already challenged you accepts their challenge.
- A player can be in at most 1 open duel, and the channel holds at most `maxDuels` open duels.
- Quick duels are the default (`quickDuel:true`): accepting settles the duel at once (see the quick duel rule below). The HP fight described next runs only when a config sets `quickDuel:{live, streamId?}` (`live` true, false or null`; no screen does that, so it takes an admin config call. StreamElements has no attack commands, so its duels are always quick.
- HP fight abilities: `strike` and `heavy` deal `damage`; `heal` restores `amount`, capped at maxHp. Each
  ability has its own `cooldownMs`, plus a shared cooldown of `sharedCooldownMs` after any action.
- The first player to reach 0 hp loses. The winner returns to maxHp. The loser is KO'd until
  `respawnAt = now + respawnMs`. Elo uses K=`eloK` from `initialElo`. The same pair cannot duel again
  for `rematchDelayMs`.
- A quick duel (the default, and always the case for StreamElements commands) is rolled at once: turns alternate, challenger first; a d6 per swing gives a crit of 50% maxHp on 6, a hit of 34% on 5, a miss on 3-4 and a defender counter of 34% on 1-2. After 12 rolls more hp wins; equal hp goes to sudden death (the next blow wins). A winner at full hp gets +3 Elo (flawless). The result stays off chat until the stream has shown it: the duel gets `revealAt` = settle time + 2200 ms + 1800 ms per roll + `streamDelayMs` (the channel's stream delay, 6000 by default). Until then the StreamElements reply is only "Fight on: A vs B! Watch the stream for the winner.", and `!elo`, `!ranks`, `/api/leaderboard`, `/api/profile` and `/api/looks` show both fighters' numbers from before the fight (their rank is worked out on those numbers), with full hp and no `respawnAt`; `POST /api/profile` answers with the same masked numbers. Any challenge that involves either fighter answers `result_hidden` ("That fight is still playing on stream."), the same for winner and loser, so a third viewer can't probe who lost; the pair itself gets `rematch_cooldown`. The overlay announces the winner and the Elo change at the end of the replay. `/api/state`, the live websocket and the admin snapshot are not masked, because the overlay and mods need them, so anyone who opens the overlay page sees the result before the stream does. The masking keeps chat replies and ranks from spoiling the stream; it does not keep the result secret.
- An active duel with no action for `inactivityMs` is cancelled without scoring. Cancelled duels
  return both players to maxHp.
- Upgrades (server/upgrades.js): every win earns one point and check-ins add more (`bonus`), at most 20 together, spent on power (+4% damage dealt per point), guard (-4% damage taken) and luck (4% per point that a quick-duel miss lands as a hit), at most 8 each. Profiles carry `bonus` (check-in points), `checkins` and `streak`; the profile answer's `upgrades` has `points`, `fromWins` and `fromCheckins`. Points can be moved while the fighter is not in a duel. Hats are cosmetic; some unlock at a number of wins. A rank reset clears Elo and wins but keeps `bonus`.
- Check-ins (the StreamElements `checkin` action; the test site's dev chat also takes `!checkin`, Twitch EventSub chat does not): once per stream, only while Twitch's Helix `/streams` says the channel is live (cached 60 s; a Twitch error answers "try again" and is not cached). Gives `checkinPoints` (bonus capped at 1000). The streak counts the channel's streams in a row that had any check-in; one missed stream is forgiven once every 7 days. With `streakBonus`, a streak of 3, 7, 14 or 30 gives +1 more. Reasons: `checked_in`, `already_checked_in`, `not_live`, `no_fighter`, `twitch_error`. On the test Worker, `POST /api/devtools/<ch>/live` with `{live, streamId?}` (DEV_TOOLS_TOKEN only) replaces the Twitch answer: `true` is live, `false` is offline, and `null` goes back to asking Twitch.
- Ranked play needs a saved profile (`ranked_sign_in_required`).
- Reason codes: `active_player_cap`, `challenge_not_found`, `channel_full`,
  `config_version_conflict`, `config_version_not_found`, `cooldown` (+`retryAt`), `duel_not_found`,
  `duels_disabled`, `duplicate`, `invalid_ability`, `invalid_config*`, `invalid_event`,
  `missing_message_id`, `not_game_command`, `not_in_active_duel`, `not_in_duel`, `player_busy`,
  `profile_not_found`, `ranked_sign_in_required`, `chat_offline`, `rematch_cooldown` (+`retryAt`),
  `respawning`, `result_hidden`, `self_duel`, `stale_command`, `target_not_found`, `unknown_subscription`, `in_duel`, `invalid_profile`,
  `target_required`, `unauthorized`, `unknown_admin_action`, `unknown_config_field`, `wrong_opponent`.

## 7. Config and balance

| field | default | range |
|---|---|---|
| enabled | true | boolean |
| quickDuel | true | boolean (true: accepting settles the duel at once; {live, streamId?}` (`live` true, false or null: the HP fight) |
| announce | "off" | "off", "top" or "bottom" (overlay duel banner) |
| maxOnStream | 50 | 15 to 100 (characters walking on the overlay) |
| maxHp | 100 | 1 to 1000 |
| maxDuels | 5 | 1 to 5 |
| challengeTimeoutMs | 30000 | 5000 to 300000 |
| inactivityMs | 45000 | 10000 to 600000 |
| respawnMs | 3000 | 0 to 60000 |
| rematchDelayMs | 30000 | 0 to 600000 |
| streamDelayMs | 6000 | 0 to 60000 (how far the stream runs behind chat; quick-duel results stay off chat this long after the overlay shows them) |
| sharedCooldownMs | 1000 | 250 to 60000 |
| initialElo | 1000 | 0 to 10000 |
| eloK | 24 | 1 to 100 |
| checkinPoints | 1 | 0 to 3 (upgrade points per check-in) |
| streakBonus | true | boolean (+1 point at a streak of 3, 7, 14 and 30 streams) |
| abilities.strike | `{damage:20, cooldownMs:2000}` | damage 1 to 1000, cooldownMs 250 to 600000 |
| abilities.heavy | `{damage:35, cooldownMs:5000}` | same as strike |
| abilities.heal | `{amount:15, cooldownMs:12000}` | amount 1 to 1000, cooldownMs 250 to 600000 |

Values must be integers (except `enabled`, `quickDuel` and `streakBonus`, which are booleans, and `announce`, which is text). Unknown fields are rejected, except `relayLeaseMs`,
which belonged to the removed chat relay and which older history versions still carry; it is ignored (and dropped when a config is read) so those versions can still be rolled back. A patch may contain any
subset of fields. Versioning works like this:
- The first preset was strike 10 / heavy 25 / heal 15 with `inactivityMs` 60000. A channel still at `configVersion` 1 with exactly that config moves to the current defaults when its room loads; a channel whose config was edited keeps its values.
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
  (the EventSub callback and OAuth redirect origin), `OWNER_TWITCH_ID` (text, nesszerra's Twitch id; left out under `MINI_LOCAL_TEST=1`) and the secrets
  `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `AUTH_SECRET`, `INTERNAL_SECRET`. `GITHUB_TOKEN`,
  `GITHUB_REPO`, `CF_API_TOKEN` and `CF_ACCOUNT_ID` are optional secrets set with
  `wrangler secret put` (docs/LIVE_FIX.md); they are not declared, because declared secrets are
  required at deploy time.
