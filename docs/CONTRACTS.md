# mini-chat contracts

This file is for every lane that builds against the backend. If it disagrees with the code, the code
wins; report the difference to Lane A. `nesszerra` and `miolafff` are built in and always on. Any other
streamer turns on their own channel by signing in on `/start/` (section 2a). A channel that isn't set up returns 403
`{error, off:"not_enabled"}`; a channel that is turned off returns 403 `{error, off:"paused"}` on
every route except `access`, `admin`, `leaderboard`, `catalog`, `assets`, `pets` and a GET of `shop` or
`profile`, so its streamer and mods can still sign in and turn it back on, and viewers still see their saved
fighter (saving and buying stay closed).

## 1. Conventions

- JSON responses carry `Cache-Control: no-store`. Errors look like `{ "error": "<message>" }`.
  Game errors also include `reason` (a snake_case code, listed in section 6).
- Mutations (`POST`, `DELETE`, ...) must send `Origin` equal to the site origin, or they get 403.
  The exceptions are `POST /api/eventsub`, which Twitch calls (its HMAC signature authenticates it), and the
  test site's dev-token requests (`Authorization: Bearer`, docs/DEVTOOLS.md); a Bearer that doesn't match gets
  401 `{error:"Invalid dev token"}`.
- Request bodies must be a JSON object. Malformed JSON, `null` or an array returns 400; a body
  over the route's limit returns 413.
- Auth uses the `mini_session` cookie (HttpOnly), set by `/auth/callback`. It and its AuthStore `session:<hash>` record
  last 30 days (`SESSION_S` in server/auth.js), so viewers stay signed in between streams; signing out ends it.
- Every response carries `Strict-Transport-Security: max-age=31536000; includeSubDomains` on https. Pages get a
  Content-Security-Policy with `script-src 'self'` plus Cloudflare's Web Analytics beacon (no inline script, no eval) and `frame-ancestors 'none'`; the overlay
  has the same without the beacon or `frame-ancestors` (OBS and the /start demo load it), and sends `Cache-Control: no-transform` so
  Cloudflare doesn't inject the beacon there. `/api/*` and `/auth/*` get a policy that
  allows nothing. The policies live in server/security.js and are repeated in `public/_headers` (a test keeps them equal).
- Writes (POST/PUT/DELETE on `/api/profile`, `/api/shop`, `/api/assets`, `/api/pets`, `/api/admin`) are limited to 30 a
  minute per signed-in user across all channels (sliding window kept in AuthStore, server/ratelimit.js). Over the limit:
  429 `{error, reason:"rate_limited", retryAfter}` plus a `Retry-After` header (seconds). Reads and dev-token requests
  are not counted. If AuthStore can't count, the write goes through.
- Roles come from `GET /api/access/:channel`: `owner` (the nesszerra account: its Twitch id must equal
  `OWNER_TWITCH_ID` when that binding is set, otherwise the `owner:nesszerra` record), `broadcaster` (the
  channel's own account), `moderator` (Helix moderator check, needs the stored broadcaster token) and
  `canManage = owner || broadcaster || moderator`.
- Unknown errors return 503 `{error:"Service unavailable; check owner diagnostics"}` and are
  logged for the developer page.

## 2. HTTP routes

Pages (server/worker.js `page()`): `/` is the intro (intro/index.html); `/?channel=x` is that channel's fighter page;
`/play/` is the channel picker (`/play/?channel=x` moves to `/?channel=x`, `/play` to `/play/`); `/intro/` moves to `/` (301).
`/admin/` without `?channel=` sends a signed-in streamer whose own channel is set up (on or turned off) and who can manage
it to `/admin/?channel=<their login>` (302); anyone else
gets the page, which offers sign-in or `/start`. The intro's main buttons say "Back to <channel>" when the fighter page
stored one in this browser (`localStorage` `pixfray:channel`, src/intro/back.js). Pages on the staging and test hosts also
send `X-Robots-Tag: noindex, nofollow`. Hashed bundles under `/assets/build/` are cached for a year (`immutable`);
everything else is revalidated.

| Method | Path | Auth | Request | Success response | Errors |
|---|---|---|---|---|---|
| GET | `/auth/login[?channel=x][&connect=1\|mods\|bot][&next=<page>]` | none | none | 302 to Twitch. The OAuth `state` is the pending sign-in itself, sealed with `AUTH_SECRET` (AES-GCM, 10 minutes) and echoed in the `mini_oauth` cookie, so starting a sign-in writes nothing to AuthStore. `next` is the page to come back to, with its query and `#tab` (the pages send their own address); anything that isn't a path on this site, or is under `/auth/` or `/api/`, becomes `/` (`safeNext` in server/auth.js). Without `channel` and with `next=/admin/` (the bare mod page) the sign-in names no channel and comes back to `/admin/?signed_in=1`, where the Worker sends a streamer to their own channel. `connect=1` (nesszerra only) asks for the EventSub chat scopes; `connect=mods` asks the channel's broadcaster for `moderation:read` and comes back to `/admin/?channel=x&mods=connected\|denied\|wrong_account#chat` | 403 channel not set up, 403 `connect=1` on a channel other than the default one, 503 when Twitch is not configured |
| GET | `/auth/login?signup=1[&mods=0]` | none | none | 302 to Twitch, asking for `moderation:read` (plus `channel:bot` where `CHAT_BOT=1`) unless `mods=0`, which asks for nothing. Comes back to `/admin/?channel=<login>&signed_in=1#chat`, with `bot=allowed` when `channel:bot` was granted; the page then connects chat through the bot | 503 |
| GET | `/auth/login?channel=x&connect=bot` | none | none | Only where `CHAT_BOT=1`. 302 to Twitch asking the broadcaster for `moderation:read channel:bot`, so the PixFray bot may read and write their chat; comes back to `/admin/` with `bot=allowed` and stores the broadcaster token | as `/auth/login` |
| GET | `/auth/login?bot=1` | none | none | The PixFray bot account's own sign-in (`user:read:chat user:write:chat user:bot`). Stores `bot:twitch` (its id and sealed token) and comes back to `/admin/?channel=<default>&signed_in=1&bot=connected` | 403 `{error:"This site has no PixFray chat bot"}` unless `CHAT_BOT=1` and `BOT_LOGIN` are set; 403 when another account than `BOT_LOGIN` signed in |
| GET | `/auth/callback` | none | Twitch `code` and `state` | 303 to `next` plus `signed_in=1` (older `signed_in`, `mods` and `bot` flags in it are dropped; `/` and `/admin/` get `channel=` when the sign-in named one and the address lacks it), sets the cookie. A signup turns on the channel of the account that signed in (a repeat signup or a built-in channel changes nothing), stores the broadcaster token when the scope was granted, and lands on `/admin/?channel=<login>&signed_in=1#chat`. A failed signup goes back to `/start/?error=full\|denied\|failed\|taken\|review` with no session (`taken`: the channel name was set up by a different Twitch account, after a rename) | 400, 403 |
| POST | `/auth/logout` | cookie | none | `{ok:true}`, clears the cookie and the session. The page then reloads its own address (minus the sign-in flags), so signing out keeps the page and channel | 403 when cross-origin |
| GET | `/api/session` | optional | none | `{user:{id,login,displayName}\|null, owner, configured, channels:["nesszerra","miolafff"] (the built-ins), productionEnabled:false}`. `productionEnabled` is a constant `false` left from the first rollout, when production stayed closed until the broadcaster was onboarded. Nothing reads it; use `channelState` instead. | 503 when secrets are missing |
| GET | `/api/channels` | none | none | `{channels:[login,...], defaultChannel}` (`defaultChannel` is what a URL without `?channel=` falls back to; the overlay uses it): the built-ins first, then the enabled (not paused) registry channels in sign-up order. Cached 60 s per isolate. The picker at `/play/` (the viewer page without `?channel=`) shows "Which stream are you watching?" with one button per channel; every link the site, sign-in and `!fray` hand out carries `?channel=` so a fighter is never saved to the wrong channel by default. Bot lines never put punctuation right after a link (Twitch chat takes it into the link), and the pages drop characters a login can't hold from the end of `?channel=` and show the clean address (`channelParam` in src/channel-param.js), so `?channel=miolafff,` still opens miolafff | |
| GET | `/api/picker` | none | none | `{channels:[{login, top:[{displayName, username, elo, avatar}], catalog?}], catalog}`: the `/play/` picker in one request. Same channels and order as `/api/channels`; `top` is up to three fighters with at least one ranked duel, `catalog` per channel lists only the uploaded looks they wear, and the top-level `catalog` is the built-in list. Cached 60 s per isolate. | |
| GET | `/robots.txt`, `/sitemap.xml` | none | none | robots: `Disallow: /api/` and `/auth/` on the production host, `Disallow: /` on the staging and test hosts. sitemap: production host only, lists `/`, `/play/`, `/start/`; 404 elsewhere | |
| POST (GET for export) | `/api/devtools/:channel/profile\|chat\|live\|shop\|export` | dev token (test site only) | as the matching site route; see docs/DEVTOOLS.md | the same room call as the matching site route; `export` returns the raw room tables | 401 without the token (an owner session gets 404), 403 channel off |
| GET | `/api/health` | none | none | `{ok:true}`; nothing else, so the public answer reveals no version or configuration (the owner's `/api/dev/diagnostics` has `worker.version` and `twitchConfigured`) | 503 `{ok:false}` when secrets are missing |
| GET | `/api/access/:channel` | optional | none | `{owner, broadcaster, moderator, canManage, reason}` | 403 for a channel that isn't set up |
| GET | `/api/state/:channel` | none | none | Snapshot (section 3) | 403, 405 |
| GET | `/api/leaderboard/:channel` | none | none | Up to 100 `Profile` rows without `dollars` (`?private=1`, canManage only, keeps them; the mod page uses it), ordered by elo desc, then wins desc, then username (quick-duel results still on stream are not shown yet; see Game rules) | 403 |
| GET | `/api/looks/:channel?u=login1,login2` | none | at most 20 logins | `{login:{avatar, color, hat, pet, petTier, recolor, petColor, accessory, trail, winEffect, taunt, title, displayName, elo}}` for viewers with a saved fighter only. The overlay uses it for chat-only viewers, batched every 2 s; a saved look is cached 5 min and asked for again when its viewer next chats after that, "no saved fighter" is cached 1 min, and a failed lookup (such as a 429) is retried after 10 s, not cached. Every registered profile in a live snapshot replaces that viewer's cached look, so a fighter changed on the website or a new Elo stays on stream after the server drops the viewer from its active list (10 quiet minutes). Changes to viewers off that list arrive as a looks push (section 3), and every minute the overlay asks again for everyone on stage the server doesn't list. | 403 |
| GET | `/api/se/:channel/:action?k=..&id=..&u=..&d=..&t=..&m=..` | the channel's StreamElements key `k` | `action` is `challenge`, `accept`, `decline`, `rematch` (challenges the sender's last finished-duel opponent), `top` (default name `!ranks`), `elo`, `help` (default name `!fray`), `look` (default name `!look`: a link to the Fighter tab, "pick your fighter" or "change your look"; also while duels are paused), `checkin` (once per stream while the channel is live; see Game rules), `wallet`, `pet` (default name `!pet`, also while duels are paused) or `give` (default name `!pay`, because StreamElements' built-in `!givepoints` already answers to `!give`; the amount comes as `a=`; see Game rules). The first command with the right key makes StreamElements the chat source (and deletes a Twitch EventSub subscription), unless a mod used Disconnect chat. Each action's last arrival is recorded (at most once a minute) for the admin badges; New key clears them. The Worker checks the request before any Durable Object call ("StreamElements route checks" below). | always 200 `text/plain`: the one-line chat reply for the bot to post (empty for a repeated message id) | 405 not GET, 404 path doesn't match or a well-formed key on a channel that isn't set up, 429 from the edge rate limit, 503 `INTERNAL_SECRET` missing |
| GET | `/api/catalog/:channel` | none | none | `[...static characters.json, ...custom entries]` (section 5) | 403 |
| GET | `/api/profile/:channel` | cookie | none | `Profile & {owned:{pets:[id], hats:[id], recolor:[id], petcolor:[id], accessory:[id], trail:[id], effect:[id], taunt:[id], title:[id], slots:n}, builds:[Loadout\|null]}` or `null`. `slots` is 1 free plus the bought ones; `builds[i]` is slot i's saved loadout (`avatar, color, defaultAbility, stats, hat, pet` and the 7 cosmetic fields), `null` if never saved; the active slot is always the profile itself | 401 |
| GET | `/api/profile/:channel/others` | cookie | none | `{fighters:[{channel, avatar, color, defaultAbility, lastSeen}]}`: the viewer's saved fighters on other channels that are on or paused, newest `lastSeen` first. It checks the channels in AuthStore `fighters:<userId>` plus the built-in ones, at most 5. Only the base look; gear stays on its channel. The fighter page offers these as "Use my <channel> fighter" when the viewer has no fighter on this channel | 401, 404 any other subpath or method |
| POST | `/api/profile/:channel` | cookie | `{avatar, color:"#rrggbb", defaultAbility:"strike"\|"heavy"\|"heal", stats?:{power,guard,luck}, hat?, pet?, recolor?, petColor?, accessory?, trail?, winEffect?, taunt?, title?, build?}`, max 4000 bytes. `stats` are checked against the points from shown wins (a duel result the stream hasn't played yet doesn't count) plus check-ins, `hat` against the shown wins or a bought hat (server/upgrades.js), and `pet` (`""` for none, at most 64 chars) against the pets the fighter owns (`pet_locked`); a change of stats or pet boost while the fighter is in a duel is refused (`in_duel`). Leaving `pet` out keeps the saved pet. Each cosmetic field is `""` (none) or an id from `/api/shop` `items` that the fighter bought (`item_locked`; the one already worn is kept); left out keeps the saved one. `build` (an integer 0 to 4, else a plain 400; a slot not bought yet is `invalid_build`) is the slot the loadout is saved to, and it becomes the active one; left out = the active slot. A save never changes Elo, wins, losses or the last opponent: a fighter off the active list (10 quiet minutes) rejoins with the ones in its saved profile. | `{profile, revision}`; `profile` carries `upgrades`, `owned` and `builds` as in the GET (a build saved with an uploaded pet deleted since comes back with `pet:""`) | 400 invalid field or unknown character, 401, 403 "That sprite belongs to another viewer" (a viewer sprite with another `owner`), 413 |
| GET | `/api/sprite/:channel` | cookie | none | The viewer's own sprite: `{live, pending, rejected, submitsLeft, aiLeft, ai:{available, left}, limits}`. `live` has `url`; each is `{id, label, status, createdAt, ...}` or `null`. `ai.available` is false where the Worker has no `AI` binding (local dev, tests) | 401, 403 channel off |
| GET | `/api/sprite/:channel/pending` | cookie | none | The viewer's waiting sprite PNG (`private, no-store`) | 401, 404 |
| POST | `/api/sprite/:channel` | cookie | `{label:1-24 chars, image:<base64 PNG, data: prefix allowed>, ai?:bool}`; at most 128 by 128 px and 64 KB. The page makes the PNG (src/spritify.js). The Worker forwards the session's id and name, never ones from the body | 201 `{ok:true, pending}`. Replaces the viewer's waiting or turned-down sprite | 400 `invalid_label`/`invalid_image`/`image_dimensions`, 413 `image_too_large`, 415 `not_png`, 401, 409 `queue_full` (40 waiting per channel), 429 `daily_limit` (6 sends per viewer per UTC day) |
| DELETE | `/api/sprite/:channel/pending\|live` | cookie | none | `{ok:true}`. `live` also puts fighters wearing it back on `player` | 401, 404 `not_found` |
| POST | `/api/sprite/:channel/redraw` | cookie | `{image:<base64 PNG or JPEG under 512 px a side, at most 768 KB>}` | `{ok:true, image:<base64>, left}`: Workers AI (`@cf/black-forest-labs/flux-2-klein-4b`, 512 by 512) redraws the subject as pixel art on white. The page then pixelates it like any picture. A failed model call gives the redraw back | 400 `invalid_image`/`image_dimensions`, 401, 413, 429 `ai_daily_limit` (3 per viewer per day) or `ai_channel_limit` (60 per channel per day), 502 `ai_failed`, 503 `ai_unavailable` |
| GET | `/api/sprites/:channel` | canManage | none | `{pending:[Sprite], live:[Sprite]}`; `Sprite = {id, userId, username, displayName, label, status, bytes, width, height, ai, createdAt, reviewedBy, reviewedAt}` | 401, 403 |
| GET | `/api/sprites/:channel/:id` | canManage | none | The PNG of a waiting or approved sprite (`private, no-store`) | 404 |
| POST | `/api/sprites/:channel/:id` | canManage | `{action:"approve"\|"reject"\|"remove"}` | `{ok:true, ...}`. Approve makes it live (replacing the viewer's previous one), adds it to the catalog and puts the viewer in it; reject drops the image; remove deletes a live one and puts its wearers back on `player`. Each changes the snapshot revision | 400 `invalid_action`, 404 `not_found`, 409 `wrong_status` (already reviewed) or `live_limit` (300 approved per channel), 401, 403 |
| GET | `/api/pets/:channel` | none | none | `{pets:[{id, label, tier, boost:{power,guard,luck}, price, custom, url?, width?, height?}], hatPricePerWin, limits:{maxPets, maxBytes, maxSide, maxLabel}}`: the 14 built-in pets (drawn by public/pets.js), then the channel's uploaded pets. Open while the channel is paused | 403 |
| GET | `/api/pets/:channel/:id` | none | an uploaded pet id (`p-<slug>-<6 hex>`) | the PNG | 404 |
| POST | `/api/pets/:channel` | canManage | `{label:1-24 chars, tier, stat, stat2?, image:<base64 PNG, data: prefix allowed>}`; at most 64 by 64 px and 64 KB. `stat` is power, guard or luck (not used for legendary); epic needs a different `stat2` | 201 `{ok:true, item}` | 400 `invalid_label`, `invalid_tier`, `invalid_stat`, `invalid_image`, `image_dimensions`; 409 `pet_limit_reached` (24 per channel); 413 `image_too_large`; 415 `not_png` |
| DELETE | `/api/pets/:channel/:id` | canManage | none | `{ok:true}`. Removes the pet from every owner (no refund) and from fighters who bring it | 404 |
| GET | `/api/shop/:channel` | none | none | `{pets (as /api/pets), hatPricePerWin, items:{recolor, petcolor, accessory, trail, effect, taunt, title:[{id, label, price}]}, slots:{max:5, prices:[2nd, 3rd, 4th, 5th]}}` with this channel's prices. Taunts and titles are fixed preset lines; nothing a viewer types reaches the stream. Open while the channel is paused | 403 |
| POST | `/api/shop/:channel` | cookie | `{kind:"pet"\|"hat"\|"slot"\|"recolor"\|"petcolor"\|"accessory"\|"trail"\|"effect"\|"taunt"\|"title", id, price?}` (`slot` needs no id: it buys the next build slot; `price` is the integer price the page showed, checked against the current one) | `{ok:true, reason:"bought", kind, id, price, dollars, owned}`. The dollars spent are the shown balance (hidden duel payouts don't count yet). Logged as a command | 400 `unknown_item`, `already_unlocked` (the hat's wins are reached), `hats_not_for_sale` (`hatPricePerWin` 0); 401; 403 while paused; 404 `no_fighter`; 409 `owned`, `not_enough` (`{price, dollars}`), `max_slots` (5 slots already), `price_changed` (`{price}`: a mod changed it since the page loaded) |
| GET | `/api/admin/:channel` | canManage | none | Snapshot plus `{chatStatus (section 4), history:[{version,config,actorId,actorName,at,note}] (newest first, 50 max; actorName is the Twitch display name at save time, empty for older rows), customUsage:{count,limit,bytes}, botStatus (section 4, bot replies), access:{owner,moderator,canManage,reason}, overlays (open role=overlay sockets), modsReady (broadcaster token stored), modsLapsed (see 2a), seOnly (only where the `SE_ONLY` text binding is set by hand; no configured site sets it), chatBot (`{login, debug}` where the PixFray bot is configured, else `null`; `login` is empty until the bot account has signed in), channelState ("builtin"\|"on"\|"paused"), streamelements:{key,names,commands,seen:{action:ms},duelModuleOff,lastCommandAt,rejectedAt,timerText}}` | 401 signed out, 403 not a mod |
| POST | `/api/admin/:channel` | canManage | `{action, payload?}`, max 12000 bytes. Any `actorId` you send is replaced by the session user. | `{ok:true, reason, revision, ...}` | 400 / 403 / 404 / 409 with `{ok:false, reason, error}` |
| WS | `/api/live/:channel[?role=overlay]` | none | Upgrade | Read-only overlay socket (section 3). OBS overlays send `role=overlay` so the admin setup checklist can count them. At 200 sockets in a room, the oldest viewer-page socket is closed (1013 "room full") for the new one; overlay sockets are never dropped. | 426 without an upgrade, 429 over the per-network limit, 503 when all 200 are overlays |
| POST | `/api/eventsub` | Twitch EventSub HMAC signature (section 4) | Twitch webhook body, max 64 KB | verification: 200 `text/plain` challenge; notification, revocation, unknown types and duplicates: 204 | 400 missing headers or bad JSON, 403 bad signature or stale timestamp, 405, 413, 503 secrets missing or room failure (Twitch retries) |
| GET | `/api/assets/:channel/:id` | none | none | `image/png` atlas bytes | 404 |
| GET | `/api/assets/:channel` | canManage | none | `{items:[CatalogEntry & {bytes,createdBy,createdAt}], usage, limits}` | 401, 403 |
| POST | `/api/assets/:channel` | canManage | `{label:1-32 chars, mode:"single"\|"frames", fps:1-30, atlas:<base64 PNG, data: prefix allowed>, frames:[Frame], animations:{idle?,walk?,attack?,ko?,jump?,cheer?:[Frame]}}` | 201 `{ok:true, item:CatalogEntry, usage:{count,limit,bytes}}` | `{ok:false, reason, error}`: 400 `invalid_label`/`invalid_*`/`too_many_frames`/`frame_too_large`/`frame_out_of_bounds`/`atlas_dimensions`, 413 `atlas_too_large`, 415 `not_png`, 409 `custom_limit_reached`, 401, 403 |
| DELETE | `/api/assets/:channel/:id` | canManage | none | `{ok:true, id, usage}` | 404 `not_found`, 401, 403 |
| GET | `/api/dev/diagnostics` | owner | none | `{worker:{version,twitchConfigured,productionEnabled,deployedVersion}, room:{channel,revision,chat:{connected,lastSeen,status},chatStatus,paused,configVersion,players,openDuels,sockets:{live},errors,errorsBySource,lastError}, integrations:{github:{configured,missing[],repo,base,workflow}, cloudflare:{configured,missing[],versionMetadata}}, usage}`; `room` also has `seLastCommandAt` (0 until a StreamElements command arrives with the current key); `errors` and `lastError` count only `room` and `worker` entries, because command lines and warnings (also listed in `errorsBySource`) are not errors | 401, 403 |
| GET, POST | `/api/dev/restore` | owner | POST `{channel, at:ms}` or `{channel, undo:true}` | Point-in-time restore of one channel's room (Cloudflare keeps 30 days of every SQLite Durable Object). `at` must be between 30 days and 1 minute ago. The Worker calls the room's internal `POST /dev/restore` (arms the restore point, returns the undo point and the revision), `POST /dev/restart` (`ctx.abort()`, so the next session loads it) and `POST /dev/restored` (revision = max(old, restored) + 1, broadcast, looks reset), then keeps `{at, restoredAt, by, undo}` in AuthStore `restore:<login>` for 30 days. `undo:true` restores to that undo point and drops the record. Answers `{ok, channel, at, undone, undoSaved, players, profiles}`. GET `?channel=` answers `{channel, last:{at, restoredAt, by}\|null, windowDays:30}`. Only that room goes back; the channel registry, sessions and other channels don't. | 400 `invalid_restore_time`/`channel_required`, 404 `unknown_channel`, 409 `nothing_to_undo`, 501 `restore_unavailable` (local dev), 502 `room_unavailable`/`restart_pending` |
| GET, POST | `/api/dev/backups?channel=<login>[&day=YYYY-MM-DD[&user=<login or id>]]` | owner | POST `{channel?}` | Daily backups (`server/backups.js`). A cron trigger at 09:00 UTC calls each channel's room (built-in and signed up, paused too) at its internal `POST /dev/backup {at, status}`; the room gzips its `/dev/export` JSON, with the export head, into the `BACKUPS` D1 database: `backups(channel, day, at, bytes, data BLOB)`, one row per channel per UTC day, a second run that day replaces it. Rows older than 90 days are dropped after each run. A room that fails is logged as a Worker error and the rest still run. GET `?channel=` answers `{channel, keepDays:90, backups:[{day, at, bytes}]}` newest first; `&day=` downloads that day's export as `mini-chat-<login>-<day>-backup.json` (same shape as `/api/dev/export`); `&user=` answers `{channel, day, exportedAt, profile, purchases[], builds[]}` for one fighter. POST backs up one channel (or all) now: `{day, channels:[{channel, ok, bytes\|reason}]}`. | 400 `channel_required`/`invalid_day`, 404 `no_backup`/`fighter_not_in_backup`/`unknown_channel`, 501 `backups_unavailable` (no D1 bound, local dev), 401, 403 |
| GET | `/api/dev/ranks?channel=<login>&user=<login or id>[&limit=1..500]` | owner | none | The fighter's rank history, newest first (default 100 rows): `[{at, userId, username, elo, wins, losses}]`. The room keeps a `rank_log` row each time a stored profile's elo, wins or losses changes (SQLite triggers on `profiles`, `server/ranklog.js`), so duels, resets, restores and saves all land there. Rows are kept 365 days; a room's first rows are its fighters' ranks when the table was created. | 400 `invalid_user`, 401, 403 |
| GET, DELETE | `/api/dev/logs[?source=room\|worker&limit=1..100]` | owner | none | GET: log rows `[{id,at,source,message,context}]`, newest first, last 500 kept. Holds error rows (`room`, `worker`), `command` rows (chat commands, purchases, gifts, profile saves) and `warn` rows (refused profile saves with the reason, from the room or, for `invalid_fields`, `unknown_character` and `sprite_not_owned`, from the Worker; bot replies held back). DELETE clears them. | 401, 403 |
| GET, POST | `/api/dev/settings` | owner | POST `{action:"config"\|"rollbackConfig", payload}` or `{action:"connectChat"\|"disconnectChat", takeover?:true}` | The same versioned config as `/api/admin` (history rows carry the owner's actorName); chat actions answer like the admin ones | 400, 403 `reconnect`, 409, 502 |
| GET, POST | `/api/dev/channels` | owner | POST `{action:"pause"\|"resume", login}` | `{builtin:[login], max, channels:[{login,enabledAt,pausedAt,pausedBy,review?}], progressBatch:40}`. GET no longer returns setup progress; the owner page reads it from `/api/dev/progress` in batches of `progressBatch` after the list renders | 400 `builtin`/`unknown_action`, 404 `not_found`, 403 `full` (resuming past 200 channels on) |
| GET | `/api/dev/progress?logins=a,b,c` | owner | `logins`: comma-separated, lowercased and de-duplicated, at most 40 (one room read each, within the Free plan's 50 subrequests per request). Each must be a built-in or a turned-on channel (a paused one is `unknown_channel`). POST gets 405. | `{progress:{login:{overlays,source,commandsWorking,commands,duelCommands,duelModuleOff,lastCommandAt,rejectedAt,lastChatAt,players}}}`. `source` is `""` while chat isn't connected. A login whose room read fails is left out. Read only: it never creates a StreamElements key. | 400 `logins_required`, 400 `too_many_logins` `{max:40}`, 400 `unknown_channel` `{invalid:[...]}`, 401, 403 |
| GET | `/api/dev/export?channel=<login>` or `?registry=1` | owner | none | A JSON download (`Content-Disposition: attachment`). `channel`: `mini-chat-<login>-<YYYY-MM-DD>.json` = `{format:"mini-chat-export", version:1, exportedAt, kind:"channel", channel, status:"builtin"\|"on"\|"paused", counts:{profiles,configVersions,customCharacters,purchases,builds,customPets}, profiles[], purchases[], builds[], customPets[], config, configVersion, configHistory[], customCharacters[], streamelements:{commandNames}}`. Profiles carry elo, wins, losses, looks, upgrade stats, hat, `lastOpponentId`, check-in points (`bonus`, `checkins`, `streak`), `dollars`, the pet, the 7 worn cosmetics and the active `build`. `purchases` = `[{userId, kind, itemId, price, boughtAt}]` (bought pets, hats, cosmetics and build slots), `builds` = `[{userId, slot, data}]` (each slot's saved loadout). `customCharacters` and `customPets` hold metadata only, no images. `registry`: `mini-chat-channels-<date>.json` = `{format, version, exportedAt, kind:"registry", builtin, channels:[{id,login,enabledAt,pausedAt,pausedBy}]}`. Neither includes StreamElements keys or Twitch tokens. A paused channel still exports. The Worker reads one room through its internal, read-only `GET /dev/export` (`server/developer.js`). | 400 `export_target_required`, 404 `unknown_channel`, 502 `room_unavailable`, 401, 403 |
| GET | `/api/dev/usage`, `/api/dev/versions` | owner | none | Request usage and Worker versions from the Cloudflare API, or `{configured:false, error}` / `missing[]` when `CF_API_TOKEN`/`CF_ACCOUNT_ID` are unset | 401, 403 |
| GET/POST | `/api/dev/code/tree`, `code/file`, `code/save`, `code/pr`, `runs`, `deploy`, `promote`, `hotfix`, `rollback` | owner | See docs/LIVE_FIX.md | GitHub-backed flow | 501 `{reason:"github_not_configured", missing:[...]}` until `GITHUB_TOKEN`/`GITHUB_REPO` are set; 404 `unknown_route`, 405 `method_not_allowed`. The dev token gets 403 `owner_session_required` on `promote`, `hotfix` and `rollback` with `target:"production"`. `code/save` refuses build files for everyone with 403 `build_file` (`package.json`, `package-lock.json`, `.npmrc`, `site.config.js`, `site.config.ts`, `cloudflare.config.ts`, `vite.config.js`, `vite.config.ts`, `tsconfig*.json`, `types/`, `scripts/`; readable, not saved) |

### StreamElements route checks (`/api/se/...`)

`handleStreamElements` (server/streamelements.js) answers these before any room is called, in order:
1. Method must be GET (405).
2. The path must match `/api/se/<channel>/<action>` (404 "Unknown command").
3. The action must be one of the twelve above. Anything else (an old `!attack` command, say) answers 200 "Lost in the arena? Type !fray".
4. The key `k` must be present and at most 128 characters, or the reply is 200 "PixFray: missing key. Copy the commands again from the admin page."
5. The key must match `/^[a-f0-9]{48}$/`, or 200 "PixFray: wrong key. Copy the commands again from the admin page."
6. A refused (channel, key) pair is answered with the same wrong-key text from a per-isolate cache for 60 s, with no Durable Object request. The first refusal still reaches the room, which records `rejected_at` for the admin badge. A pair enters the cache when the room answers 403 with a reply. The cache holds 2000 pairs. The room's `/se` answer carries `X-Se-Key`, a hash of the channel's current key; the Worker keeps it per channel for 60 s and refuses other keys without a Durable Object request, letting one through every 10 s so a rotated key is picked up.
7. Channel state: paused answers 200 "PixFray is off on this channel right now."; not set up answers 404.
8. Then the room checks the key and runs the command.

Steps 3 to 5 come before the channel lookup, so an unknown channel with a bad action or a malformed or missing key gets the 200 text, not 404. A well-formed key on an unknown channel is still 404.

Edge rate limit (Cloudflare WAF). Zone `pixfray.xyz` (pixfray.xyz and staging.pixfray.xyz): ruleset "PixFray rate limit" (id `0bbc82dec3f244d38ea0b11639cd555c`), rule id `9645c20ff84544f4a3616e04f2858cbf` (version 1, 2026-10-05), the same expression and limits as below. Zone `miolaf.xyz` (chat.miolaf.xyz and test.chat.miolaf.xyz, whose Workers were deleted on 2026-10-08): ruleset "PixFray rate limit" (id `c14d229ed8534be9b8d10168bcfc664d`), rule id `c7ecb06b07954bf6b2207c726dab6a1f` (ruleset version 2, 2026-10-03). Expression `starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/auth/")`, 20 requests per 10 s per IP and colo, then block for 10 s, so one IP can make at most about 86,000 Worker requests a day (the free quota is 100,000). The Free plan allows only this one rule, 10 s windows and 10 s blocks. StreamElements' servers share IPs across channels, so many busy channels at once could hit the limit; their commands then get no reply for 10 s. The first version (only `/api/se/`, 100 per 10 s) is saved in `work/ratelimit-backup-2026-10-03.json`. It lives in Cloudflare, not in this repo. To undo it, put the ruleset for phase `http_ratelimit` with an empty rules list.

Security: StreamElements passes the viewer's id and login in the query (`id=$(sender.twitchid)`, `u=$(sender.name)`), so anyone who holds a channel's key can send commands as any viewer of that channel. The key is the only secret. Keep the admin page's key off stream, and press New key if it leaks (docs/STREAMER_SETUP.md).

### 2a. Channel registry (server/channels.js)

Built-in channels come from `CHANNELS` in `server/auth.js`. Signed-up channels live in the AuthStore
Durable Object. Signup is open: a Twitch sign-in through `/auth/login?signup=1` turns on the
channel of that account only, so nobody can turn on someone else's channel.

- `channel:<login>` = `{id, login, enabledAt, pausedAt?, pausedBy?, review?:{reasons, at}}`. At most 200 channels can be
  on; a new signup past that goes to `/start/?error=full`, and resuming a channel counts against
  the cap too. `pausedBy` is `owner` or `broadcaster`. A channel the owner turned off stays off until
  the owner turns it back on: the streamer's `resumeChannel` gets 403 `owner_off`.
- Signup review: a new channel turns on at once only when the account is at least 30 days old and is
  Affiliate or Partner or has a saved past broadcast. Otherwise it is saved turned off (`pausedBy:owner`)
  with `review.reasons` from `young`, `never_streamed` and `unchecked` (the past-broadcast lookup failed),
  and the signup lands on `/start/?error=review` (again on a repeat signup). The owner's `resume` on
  `/api/dev/channels` approves it: the note is dropped and the channel turns on.
- AuthStore `GET /list?key=channel:` returns `[{key, value}]` (500 max). Any other prefix is 400.
  Old `invite:` records from before 2026-10-06 are no longer read and expire on their own.
- `channelState(env, ch)` is cached per isolate (60 s for a hit, 10 s for a miss), so pausing reaches
  every isolate within about a minute. `/api/session` lists the built-ins only. Where the PixFray bot
  is configured (`CHAT_BOT=1`), EventSub serves every channel that is on (the webhook finds the room by
  Twitch id in the registry); without the bot, signed-up channels use StreamElements.
- `fighters:<userId>` = `{channels:[login]}`, the channels where the viewer saved a fighter, newest save first, at most 8. A successful `POST /api/profile/:channel` moves the channel to the front; kept 90 days from the last save. Read by `GET /api/profile/:channel/others`.
- `modsconnected:<login>` = `{at}`. Written when mod access is connected (`connect=mods`, a signup that grants `moderation:read`, or `connect=1`), and also by an admin page view that finds a stored token without one. Expires after 20 years (the AuthStore accepts expiries up to 21 years for `channel:`, `modsconnected:` and `bot:` keys, 100 days for everything else).
- `broadcaster:<login>` = the sealed Twitch token plus `touched` (ms). It is kept 90 days from its last use: every save refreshes the expiry, the hourly token validation re-saves it, and an admin page view re-saves it when `touched` is more than 7 days old. A 401 from Twitch renews the access token with the stored refresh token. If the record expires or the refresh fails, mod checks stop (`modsReady:false`).
- `GET /api/admin/:channel` adds `modsReady` (the `broadcaster:<login>` record exists) and `modsLapsed` (`modsconnected:<login>` exists but `broadcaster:<login>` is gone). They are never both true. `modsLapsed` makes the admin page show "Expired" and "Reconnect mod access" instead of "Connect mod access" in Stream setup.
- `OWNER_TWITCH_ID` is a text binding, nesszerra's public Twitch id `445610108`, declared for prod and test in `cloudflare.config.ts`. When it is set, `isOwner` compares the session user's id to it and ignores the `owner:nesszerra` record (which expires 90 days after the last sign-in). It is not declared when `cf dev` runs with `MINI_LOCAL_TEST=1` (the test server), where seeded sessions use owner id 900001 and the `owner:nesszerra` record decides. A plain `cf dev` without that flag does declare it.
- An overlay on a paused or unknown channel draws nothing and reloads every 5 minutes. One that was
  already open when the channel was paused keeps running until OBS reloads it. StreamElements
  commands on a paused channel answer "PixFray is off on this channel right now."

### Admin actions (`POST /api/admin/:channel`)

| action | payload | Effect |
|---|---|---|
| `config` | `{patch:{...}, baseVersion?, note?}` (`config` works as an alias of `patch`) | Validates the patch (section 7), increments `configVersion` and records a history row. A `baseVersion` that does not match returns 409 `config_version_conflict`. Running duels keep their old rules. |
| `rollbackConfig` | `{version}` | Applies the stored config as a new version, with note `rollback to vN`. A missing version returns 404 `config_version_not_found`. |
| `cancelDuel` | `{duelId}` | Cancels the duel without scoring it. If it was active, both players go back to maxHp. |
| `resetHealth` | none | Every active player goes to maxHp, and respawn is cleared. |
| `resetRank` | `{userId}` | Sets elo to initialElo and wins and losses to 0. Works for offline profiles too. |
| `restoreRank` | `{userId, elo, wins, losses}` or `{userId, before}` | Sets one fighter's elo (0 to 10,000), wins and losses (0 to 1,000,000), active or offline, to repair a rank lost to a bug. With `before` (epoch ms) it uses the fighter's last rank history row before that time (404 `no_rank_history` when there is none). Site owner only (403 `{error, reason:"owner_only"}`). 400 `invalid_rank`, 400 `profile_not_found`. Logged as a command (`<owner> restored rank <elo>/<wins>/<losses> -> <userId>`). |
| `resetAllRanks` | none | The same reset for every stored profile, and the daily pair counts (`pairPlays`) start over. Broadcaster or owner only (403 `{error, reason:"broadcaster_only"}`); clear arena and the other resets stay with mods. |
| `resetRound` | none | Cancels open duels and sets `round` to 0. |
| `resetAll` | none | Clears players, duels and locks. Stored profiles stay. |
| `removePlayer` | `{userId}` | Removes the player from the arena and deletes the stored profile. |
| `connectChat` | none | Handled by the Worker, not the room. Ensures exactly one Twitch EventSub `channel.chat.message` webhook for this site (section 4) and records it in the room. Where `CHAT_BOT=1` it subscribes as the PixFray bot (condition `{broadcaster_user_id, user_id:<bot id>}`); otherwise only the default channel can connect, with the owner's own subscription (400 on other channels or with `SE_ONLY=1`: use StreamElements). `takeover:true` needs the broadcaster or the owner (403 `broadcaster_only`). Returns `{ok, reason, revision, chatStatus}`. 403 `{error, reconnect:"/auth/login?connect=1"}` when Twitch reports missing authorization; 409 `{reconnect}` when the broadcaster id is unknown; 409 `{error, connectedElsewhere}` when another site holds the chat subscription (retry with `takeover:true` to move it here, section 4); in bot mode 409 `{reconnect:"/auth/login?bot=1"}` until the bot account has signed in and 403 `{reconnect:"/auth/login?channel=x&connect=bot"}` when Twitch refuses the bot; 502 when Twitch fails. |
| `disconnectChat` | none | Deletes the subscription at Twitch, marks chat disconnected, pauses duels and cancels open ones (`chat_disconnected`). StreamElements commands don't reconnect a channel turned off this way. |
| `pauseChannel` / `resumeChannel` | none | Handled by the Worker; the broadcaster or the owner only (403 for mods). Turns a signed-up channel off or back on (`channel:<login>.pausedAt`). The broadcaster can't turn back on a channel the owner turned off (403 `owner_off`). Fighters, ranks and settings are kept. Other isolates notice within a minute. 400 for a built-in channel. Returns `{ok:true, channelState}`. |
| `giftDollars` | `{username, amount}` | Adds PixFray dollars to a saved fighter (`@` allowed before the name), or takes them back with a negative amount; the balance stays between 0 and 1,000,000. `amount` is a whole number from -10000 to 10000, not 0 (400 `invalid_amount`); 404 `profile_not_found`. Logged as a command (`<mod> gift <amount> -> <login>`). Returns `{ok:true, reason:"dollars_gifted", username, displayName, amount, dollars}`. |
| `saveCommand` / `deleteCommand` / `setCounter` | `{name, reply, oldName?}` / `{name}` / `{name, value}` | The PixFray bot's own text commands (room tables `bot_commands`, `bot_counters`; server/botcommands.js), any mod. A name is `!` plus 1 to 24 of `a-z0-9_`, stored lowercase (400 `invalid_command_name`); it can't be a PixFray command's name (the channel's names, their defaults, `!give`, `!pay`: 400 `command_name_taken`) or another existing command (400 `command_exists`; `oldName` renames). The reply is 1 to 400 characters after collapsing spaces (`empty_command_reply`, `command_reply_too_long`); once filled in, a line over 480 characters is cut at a word break with `…`, and saving a reply whose worst case would be cut still succeeds with `{warning:"reply_may_be_cut", longest, max:480}`; at most 50 commands (`too_many_commands`). In a reply `${user}` is the sender, `${touser}` the first word after the command without `@` (else the sender), `${count x}` adds 1 to counter `x` and shows it, `${getcount x}` shows it; `$(...)` works the same. Saving creates its counters at 0. `setCounter` takes a whole number from 0 to 1,000,000,000 (`invalid_counter_name`, `invalid_counter_value`); deleting a command keeps its counter. In chat, only the PixFray bot answers them (not StreamElements): each command at most every 5 s, and every 15 s per chatter, inside the bot's 14 command replies per 30 s (section 4). A reply the cap drops doesn't start the cooldown or change counters. `GET /api/admin/:channel` returns `botCommands` (`{commands:[{name, reply}], counters:[{name, value}], max}`). Returns `{ok:true, reason, botCommands}`. |
| `setDuelModuleOff` | `{value:boolean}` (top level) | Handled by the Worker. Saves the setup checklist tick "StreamElements Duel module turned off". New key keeps it. |
| `rotateSeKey` | none | Handled by the Worker; broadcaster or owner only (403 `broadcaster_only`). Makes a new StreamElements key (New key) and clears the heard and rejected badges. |
| `setSeNames` | `{names:{action:"!name"}}` | Handled by the Worker, any mod. Renames the StreamElements commands: each name is `!` plus 1 to 24 of `a-z0-9_`, and each action needs its own name (400 `{error}`). |
| `useStreamElements` | none | Handled by the Worker, any mod. Records StreamElements as the chat source and deletes any Twitch subscription. |
| `checkinTest` | `{value:boolean}` (top level) | Handled by the Worker, any mod, on the site channel (`site.defaultChannel`) only; any other channel gets 403. `true` turns check-in test mode on for 15 minutes (room table `checkin_test`, `{until, by}`), `false` ends it. While it's on and Twitch says the channel is offline, `!checkin` works out the check-in the next stream would give and answers "[Test, not saved] @name would check in: ..." without writing anything (no points, streak, check-in count or stream row), so it can be repeated. While the channel is live, check-ins count as usual. `GET /api/admin/:channel` returns `checkinTest` (`{until, by}` or `null`) and `checkinTestAllowed` (whether this channel shows the control). Returns `{ok:true, checkinTest}`. |

## 3. Overlay socket `/api/live/:channel`

The server sends a snapshot as soon as the socket opens and after every visible change. The only
message a client may send is the text `ping`, which the room's WebSocket auto-response answers with
`pong` without waking the Durable Object; any other client message closes the socket with 1008.
`public/arena-client.js` pings every 20 s and replaces a socket that has received nothing, not even
`pong`, for 45 s (half open). Reconnect with backoff, and use `GET /api/state/:channel` for the state
after each (re)connect.

```
Snapshot = {
  type:"snapshot", channel, revision:int, paused:bool,   // paused = chat not connected or config.enabled false
  chat:{connected:bool, lastSeen:ms, status, bot:bool}, config:Config, configVersion:int, round:int,
  players:Player[], duels:Duel[], events:Event[],         // events: the last 50, oldest first
  serverNow:ms                                            // server clock when sent
}
Player = {userId, username, displayName, avatar, color, defaultAbility, hp, elo, wins, losses,
          lastSeen, registered:bool, respawnAt:ms,         // respawnAt > now means KO'd
          stats, hat, bonus, pet, petTier, petBoost, recolor, petColor, accessory, trail, winEffect, taunt, title}
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

Between snapshots the server may also send a looks push (`lookChanged` / `flushLooks` in `server/channel.js`):

```
Looks = {type:"looks", looks:{[login]: Look|null}, reset?:true}
Look  = the /api/looks fields, with hidden duel results masked the same way
```

It goes out once per turn of the event loop after any write to a saved fighter (website save, duel result, approved or
removed sprite, rank reset, deleted profile) for viewers who are **not** in `players`; snapshots already carry those.
`null` means the saved fighter was deleted, and the overlay puts that viewer back to their chat name and color.
`reset:true` (all ranks reset) means every cached look is stale. A looks push has no revision and no events. On top of
it, the overlay asks `/api/looks` again once a minute for everyone on stage the server doesn't list, so a missed push
fixes itself.

Event types and their fields:

| type | fields |
|---|---|
| `challenge_created` | duelId, a, b, expiresAt |
| `challenge_declined` | duelId, declinedBy |
| `challenge_expired` | duelId, a, b |
| `duel_started` | duelId, a, b, round, hp |
| `duel_action` | duelId, userId, targetId (the actor for heal), ability, amount, hp. Also sent for the final blow. A quick-duel roll adds die (1-6) and one of miss, crit or counter (userId is then the defender who counters), and finisher on the last blow. |
| `duel_completed` | duelId, winnerId, loserId, round, respawnAt, hp, ratings. Quick duels may add flawless (ratings of the winner then include bonus) and decision (`hp` or `sudden_death`); an unrated duel adds `unrated` (`new_account` or `pair_cap`). |
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

Chat reaches the game only through one Twitch EventSub subscription per channel, delivered by webhook to the
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
   changes nothing. Ids of command messages (a line starting with `!`, or anything read as the bot) are kept in the
   room's SQLite table `eventsub_seen` (server/dedupe.js, 10 minutes, swept at most once a minute), so a redelivery
   that lands on a restarted room is still a duplicate; plain chat lines are only remembered in memory. The claim is
   released if handling throws, so Twitch's retry after a 5xx plays. Commands are also deduplicated durably by the chat `message_id`.

Message types:
- `webhook_callback_verification`: answers 200 `text/plain` with `challenge`. Chat counts as
  connected when the subscription is `enabled` or its verification arrived (in either order).
- `notification` for `channel.chat.message`: routed by `event.broadcaster_user_login`; other
  channels, and signed-up channels that are turned off, are ignored. A subscription whose `user_id` isn't
  the broadcaster reads as the PixFray bot: only messages starting with `!` reach the room (anything else
  answers 204), and the room's reply goes back through Helix as the bot, at most 6 lines per message. The room requires `subscription.id` to match the connected subscription.
  Every message refreshes the chatter's presence (at most once per 30 s, with the Twitch name color
  for unregistered chatters). Text matching the command regex below also runs as a command; a
  rejected command is logged as a `command_rejected` event. Twitch gets no reply.
- `revocation`: if the id matches, chat is disconnected with the Twitch status as the reason;
  duels pause and open duels are cancelled. Returns 204.
- Anything else returns 204 and is ignored.

Bot replies and status (room table `bot_status`, one row):
- The Worker sends the room's replies with Helix Send Chat Message, then posts
  `{results:[{sent, reason}]}` (10 max) to the room's internal `POST /bot-sent`. The room counts
  sent and dropped replies; a drop is logged as a `warn` "bot reply dropped: <reason>" with the
  reason in words (`botDropText` in server/eventsub.js: duplicate, slow mode, 429, ...). Reminder
  posts do the same as "bot reminder sent" / "bot reminder dropped: ...".
- Replies the room holds back are logged as `warn` "bot reply held back: <reason>", at most once a
  minute per reason: `reply_limit` (command replies stop at 14 in 30 s; the last 4 of the cap of 18 are kept for the bot's own result and expired-challenge lines), `unknown_subscription` (a message
  from an old chat subscription). A custom command on its cooldown is counted but not logged.
- A challenge that runs out unanswered gets one line from the bot: "Challenge expired: @b didn't
  answer a within 30 s. a, try again with !challenge @b". The room alarm posts it through Helix
  (counted as a sent or dropped reply); if a chat command notices the expiry first, the line goes
  before that command's reply. StreamElements channels get no such line.
- Once the stream has played a duel (its `revealAt`: the replay plus the stream delay), the bot posts the
  result: "a beat b! a 1012 Elo (+12), b 988 Elo (-12)." ("a beat b on HP" or "in sudden death" when it went
  to time, and ", flawless" when a took no damage.) The overlay shows no winner banner, so this line is the announcement.
  The snapshot's `chat.bot` is true on such a channel. The room alarm wakes for it and posts each
  result once (`bot_reminder.results_through`). A result line the cap holds back, or whose Helix call
  failed, stays due and is retried every 5 s in reveal order until it is 2 minutes past `revealAt`, then
  skipped; a bot command also posts any due result before its own reply. A line Twitch accepted and then
  dropped (AutoMod, chat settings) counts as done. Alarm errors are logged and never stop the next alarm.
  An unrated duel's line ends "Just for fun (<reason>): no Elo or dollars."
  StreamElements channels get no result line; their `!elo` and `!ranks` show it after `revealAt`.
- `GET /api/admin/:channel` returns `botStatus` `{heardAt, heard, sentAt, sent, failedAt, failed,
  failedReason, failedText, heldAt, heldReason, recent, cap}`; the admin page shows it under Chat.
- `!fray debug` from the broadcaster, a mod or the bot answers one line: chat connected or not,
  the last command and its age, replies sent and dropped, replies used in the last 30 s, the last
  held-back reason and the reminder state. Anyone else gets "only the broadcaster or a mod can use
  !fray debug."
- `!fray off` / `!fray on` from the broadcaster or a mod sets `config.botEnabled` (a config version
  noted "bot off (chat)"; the admin page's Rules, Chat bot switch is the same setting) and answers
  one line. While it's off the bot answers nothing else (including `!fray on` from viewers) and posts
  no result, expired-challenge or reminder lines; results that finish while it's off are never posted.
  Chatters still appear on the overlay. From anyone else, `!fray off` is the normal `!fray` reply.

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
On a channel the PixFray bot reads, `!accept`, `!duel` and `!top` also work as hidden aliases (the channel's own
command names and custom commands win over them), and a target may carry extra `@`, trailing `,.!?;:` and invisible
characters (`@@bob`, `bob!`). The bot account is not a valid target: `!challenge @bot` answers "The bot doesn't fight
(yet)! Name a rival: !challenge @name" and `!give @bot` "The bot doesn't take dollars. Give them to a rival!" (not on
the `BOT_DEBUG` test site).
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
                mode?:"single"|"frames", combatFallback?:"effects",   // custom uploads only
                owner?:"<twitch user id>"}                               // viewer sprites only
Frame = {x, y, w, h}   // pixel rectangle in the atlas at `url`
```

Fallbacks: `idle` and `walk` fall back to `frames`. `combatFallback:"effects"` marks a custom upload
without attack frames; `mode:"single"` (one PNG) is animated by the engine with bob and squash. If `attack` or `ko` is missing, the overlay
plays an effect (flash, shake, fade) over `idle`. Static characters live in
`public/assets/characters.json`; every asset must be listed in `docs/ASSET_LICENSES.md`.

Custom characters:
- Ids match `^c-[a-z0-9-]{1,40}$`. `url` is `/api/assets/<channel>/<id>`.
- Limits (`UPLOAD_LIMITS`): PNG only, at most 24 frames, frames up to 128x128, an atlas of at most
  1,572,864 bytes, and at most 24 characters per channel.
- Stored in the room table `custom_characters(id, meta JSON without id/url, atlas BLOB, bytes,
  created_by, created_at)`.

Viewer sprites (server/sprites.js):
- A signed-in viewer turns a picture into a sprite on the fighter page ("Your own sprite"). The browser always pixelates it
  (src/spritify.js: background removal, crop, 56 px tall, 14 colors, outline, doubled). An optional AI redraw goes
  through `/api/sprite/:channel/redraw` first. A mod approves it on `/admin/` (Characters tab).
- Ids match `^v-[a-z0-9-]{1,48}$`; each approval makes a new id, so the overlay refetches the catalog. `url` is
  `/api/assets/<channel>/<id>`, cached for a day (`immutable`). Entries are `mode:"single"`, `combatFallback:"effects"`,
  `source:"viewer"`, `license:"Uploaded by <name>"` and carry `owner`. Only the owner may wear one; the page lists only
  the viewer's own.
- One live and one waiting sprite per viewer. Limits (`SPRITE_LIMITS`): PNG at most 128 by 128 px and 64 KB, 6 sends and
  3 AI redraws per viewer per UTC day, 60 AI redraws per channel per day, 40 waiting and 300 approved per channel.
- Stored in the room tables `viewer_sprites(id, user_id, username, display_name, label, status "pending"|"live"|"rejected",
  png BLOB, bytes, width, height, ai, created_at, reviewed_by, reviewed_at)` and `sprite_usage(user_id, day, submits, ai)`.
  The test site's raw export (`/api/devtools/:channel/export`) includes `viewer_sprites` with the images; the owner's
  `/api/dev/export` leaves them out.

## 6. Game rules (game.js)

- A duel starts with `!duel @user` (or `!challenge`). The target must `!accept` (or `!fight`) within `challengeTimeoutMs`, or the
  challenge expires. Either side may `!decline`. Challenging someone who already challenged you accepts their challenge.
- A player can be in at most 1 open duel, and the channel holds at most `maxDuels` open duels.
- Quick duels are the default (`quickDuel:true`): accepting settles the duel at once (see the quick duel rule below). The HP fight described next runs only when a config sets `quickDuel:false`; no screen does that, so it takes an admin config call. StreamElements has no attack commands, so its duels are always quick.
- HP fight abilities: `strike` and `heavy` deal `damage`; `heal` restores `amount`, capped at maxHp. Each
  ability has its own `cooldownMs`, plus a shared cooldown of `sharedCooldownMs` after any action.
- The first player to reach 0 hp loses. The winner returns to maxHp. The loser is KO'd until
  `respawnAt = now + respawnMs`. Elo uses K=`eloK` from `initialElo`. The same pair cannot duel again
  for `rematchDelayMs`.
- A quick duel (the default, and always the case for StreamElements commands) is rolled at once: turns alternate, challenger first; a d6 per swing gives a crit of 50% maxHp on 6, a hit of 34% on 5, a miss on 3-4 and a defender counter of 34% on 1-2. After 12 rolls more hp wins; equal hp goes to sudden death (the next blow wins). A winner at full hp gets +3 Elo (flawless). The result stays off chat until the stream has shown it: the duel gets `revealAt` = settle time + 2200 ms + 1800 ms per roll + 500 ms + `streamDelayMs` (the channel's stream delay, 6000 by default). Until then the StreamElements reply is only "Fight on: A vs B! Watch the stream for the winner.", and `!elo`, `!ranks`, `/api/leaderboard`, `/api/profile` and `/api/looks` show both fighters' numbers from before the fight (their rank is worked out on those numbers), with full hp and no `respawnAt`; `POST /api/profile` answers with the same masked numbers. Any challenge that involves either fighter answers `result_hidden` ("That fight is still playing on stream."), the same for winner and loser, so a third viewer can't probe who lost; the pair itself gets `rematch_cooldown`. The overlay shows the knockout and the Elo change at the end of the replay (no winner banner); where the PixFray bot reads chat (`chat.bot`), it posts the result line. `/api/state`, the live websocket and the admin snapshot are not masked, because the overlay and mods need them, so anyone who opens the overlay page sees the result before the stream does. The masking keeps chat replies and ranks from spoiling the stream; it does not keep the result secret.
- Unrated duels: the same two fighters get `PAIR_RATED_PER_DAY` (5) duels that count per rolling 24 h; the next
  ones between them are `unrated:"pair_cap"` (only rated duels count toward it). A duel where either fighter has a
  Twitch account under 7 days old (`NEW_ACCOUNT_MS`) is `unrated:"new_account"`. An unrated duel is played and shown
  and still sets the rematch lock, the KO and `lastOpponentId`, but changes no Elo, wins, losses or dollars (`ratings`
  deltas are 0, no `payout`, no flawless bonus). The room asks Twitch for a saved fighter's account age once, when the
  fighter chats or saves, and retries after an hour if Twitch doesn't answer; an unknown age counts as old (fails
  open). The "Fight on" and result replies add "Just for fun (a Twitch account under 7 days old | 5 ranked duels
  between them in 24 h already): no Elo or dollars."
- An active duel with no action for `inactivityMs` is cancelled without scoring. Cancelled duels
  return both players to maxHp.
- Upgrades (server/upgrades.js): every win earns one point and check-ins add more (`bonus`), at most 20 together, spent on power (+4% damage dealt per point), guard (-4% damage taken) and luck (4% per point that a quick-duel miss lands as a hit), at most 8 each. Profiles carry `bonus` (check-in points), `checkins` and `streak`; the profile answer's `upgrades` has `points`, `fromWins` and `fromCheckins`. Points can be moved while the fighter is not in a duel. Hats are cosmetic; some unlock at a number of wins. A rank reset clears Elo and wins but keeps `bonus`.
- Dollars: every finished ranked duel pays `winDollars` to the winner and `lossDollars` to the loser, saved fighters only. game.js records it as `duel.payout` and the room adds it to `profiles.dollars` once, in the same transaction (`duel.paid`). Like Elo, a payout stays out of `!wallet`, `/api/profile` and the leaderboard until the stream has shown the fight. Profiles carry `dollars` (at most 1,000,000). Check-ins give points, not dollars. A rank reset, a profile save and a re-save keep dollars; removing a viewer deletes them.
- `!wallet` (the StreamElements `wallet` action, also while duels are paused): "@x: $N PixFray dollars, P of 20 upgrade points, S-stream streak." Reasons: `wallet`, `no_fighter`.
- Pets and the shop (server/pets.js): 14 built-in pets in 5 tiers, plus up to 24 uploaded per channel. A fighter owns any number of pets (`owned_items`) and brings one (`profiles.pet`); hats can be bought too. A pet's boost is added after the upgrade limits: common and uncommon +1 to one stat, rare +2, epic +2 and +1 to a second stat, legendary +1 to every stat. Pets cost `petPrice<Tier>` dollars; a hat whose wins aren't reached costs `hatPricePerWin` times the wins it needs. The overlay draws the pet behind its fighter at about 40% of its height; epic and legendary pets sparkle, legendary pets hover. Snapshot players and `/api/looks` carry `pet` and `petTier`; players also carry `petBoost`.
- Cosmetics and builds (server/cosmetics.js, drawn by public/cosmetics.js): recolor (a CSS filter on the fighter), pet color (the same 8 tints on the pet), accessories, walking trails, win effects (about 3 s over the winner when the overlay shows the result), win taunts (a speech bubble then) and titles (under the nameplate). Each kind has one config price. Owned cosmetics are `owned_items` rows; the worn ones are profile columns. Build slots: 1 free, the 2nd costs `buildSlotPrice`, the 3rd to 5th `buildSlotPriceMore` each. Each slot keeps its own loadout in the `builds` table; saving to a slot makes it the one on stream, and every build can spend the full point pool. Removing a viewer deletes their builds; a rank reset keeps them.
- `!pet [@name]` (the `pet` action): "@x's pet: Fox (rare), +2 power." Reasons: `pet`, `no_pet` (with the site link for the sender's own), `no_fighter`.
- `!pay @name amount` (the `give` action; on a channel the PixFray bot reads, it's `!give` and `!pay` stays an alias; `a=` is `20` or `$20`): moves dollars between two saved fighters while the channel is live (the same Twitch check as check-ins). In order it refuses with `give_off` (config `giveEnabled` false), `no_fighter`, `give_usage` (no target or no whole amount of at least 1), `target_not_found`, `self_give`, `twitch_error`, `not_live`, `too_few_duels` (fewer than `giveMinDuels` finished duels, `{duels, need}`), `give_cap` (already gave `giveMaxPerStream` this stream), `over_cap` (`{left}`), `not_enough` (`{dollars}`) and `target_full` (`{to, room}`: the receiver's wallet can't hold the amount, so nothing moves). Hidden duel results and payouts don't count yet. The limit is per Twitch stream id (`profiles.give_stream`, `given_in_stream`). Success is `given` with `{amount, to, dollars, left}`; the command log stores the amount.
- Check-ins (the StreamElements `checkin` action; the test site's dev chat also takes `!checkin`, Twitch EventSub chat does not): once per stream, only while Twitch's Helix `/streams` says the channel is live (cached 60 s; a Twitch error answers "try again" and is not cached). Gives `checkinPoints` (bonus capped at 1000). The streak counts the channel's streams in a row that had any check-in; one missed stream is forgiven once every 7 days. With `streakBonus`, a streak of 3, 7, 14 or 30 gives +1 more. Reasons: `checked_in`, `already_checked_in`, `not_live`, `no_fighter`, `twitch_error`. On the test Worker, `POST /api/devtools/<ch>/live` with `{live, streamId?}` (DEV_TOOLS_TOKEN only) replaces the Twitch answer: `true` is live, `false` is offline, and `null` goes back to asking Twitch.
- Ranked play needs a saved profile (`ranked_sign_in_required`).
- Reason codes: `active_player_cap`, `challenge_not_found`, `channel_full`,
  `config_version_conflict`, `config_version_not_found`, `cooldown` (+`retryAt`), `duel_not_found`,
  `duels_disabled`, `duplicate`, `invalid_ability`, `invalid_config*`, `invalid_event`,
  `missing_message_id`, `not_game_command`, `not_in_active_duel`, `not_in_duel`, `player_busy`,
  `profile_not_found`, `ranked_sign_in_required`, `chat_offline`, `rematch_cooldown` (+`retryAt`),
  `respawning`, `result_hidden`, `self_duel`, `stale_command`, `target_not_found`, `unknown_subscription`, `in_duel`, `invalid_profile`,
  `target_required`, `unauthorized`, `invalid_amount`, `dollars_gifted`, `item_locked`, `invalid_build`, `max_slots`, `price_changed`, the `give` reasons above, `unknown_admin_action`, `unknown_config_field`, `wrong_opponent`.

## 7. Config and balance

| field | default | range |
|---|---|---|
| enabled | true | boolean |
| quickDuel | true | boolean (true: accepting settles the duel at once; false: the HP fight) |
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
| winDollars | 5 | 0 to 100 (PixFray dollars for a win) |
| lossDollars | 3 | 0 to 100 (dollars for a loss) |
| giveEnabled | true | boolean (`!pay` on or off) |
| giveMaxPerStream | 100 | 0 to 10000 (dollars one viewer can give per stream) |
| giveMinDuels | 5 | 0 to 1000 (finished duels before a viewer can give) |
| reminderMin | 0 | 0 (off) or 10 to 240 (the PixFray bot posts the `!fray` line plus a command list every this many minutes while Twitch says the channel is live; only while the bot reads the channel's chat. The first one is a full interval after it's turned on. The room learns the bot and broadcaster ids from the bot's commands, in `bot_reminder`) |
| petPriceCommon, petPriceUncommon, petPriceRare, petPriceEpic, petPriceLegendary | 10, 25, 60, 140, 300 | 1 to 100000 (dollars per pet of that tier) |
| hatPricePerWin | 3 | 0 to 1000 (a locked hat costs this times the wins it needs; 0 = hats aren't sold) |
| recolorPrice, petColorPrice, accessoryPrice, trailPrice, effectPrice, tauntPrice, titlePrice | 20, 15, 25, 40, 50, 10, 15 | 1 to 100000 (dollars per item of that kind) |
| buildSlotPrice, buildSlotPriceMore | 60, 120 | 1 to 100000 (the 2nd build slot, then each of the 3rd to 5th) |
| abilities.strike | `{damage:20, cooldownMs:2000}` | damage 1 to 1000, cooldownMs 250 to 600000 |
| abilities.heavy | `{damage:35, cooldownMs:5000}` | same as strike |
| abilities.heal | `{amount:15, cooldownMs:12000}` | amount 1 to 1000, cooldownMs 250 to 600000 |

Values must be integers (except `enabled`, `quickDuel`, `streakBonus` and `giveEnabled`, which are booleans, and `announce`, which is text). Unknown fields are rejected, except `relayLeaseMs`,
which belonged to the removed chat relay and which older history versions still carry; it is ignored (and dropped when a config is read) so those versions can still be rolled back. A patch may contain any
subset of fields. Versioning works like this:
- The first preset was strike 10 / heavy 25 / heal 15 with `inactivityMs` 60000. A channel still at `configVersion` 1 with exactly that config moves to the current defaults when its room loads; a channel whose config was edited keeps its values.
- Shop prices were cut to about a third on 2026-10-06 (a duel pays about $4). A stored config whose price is still the old default (30, 75, 180, 420, 900; hat 10 per win; 60, 40, 80, 120, 150, 25, 50; slots 200, 400) moves to the new one once, and the state records `priceSchema: 2`. A price a mod changed is kept.
- `configVersion` starts at 1. Each successful change increments it and stores a history row, and
  the last 200 versions are kept.
- The dashboard should send `baseVersion` and, on a 409, reload and show the conflict.

## 8. Lane modules and file ownership

| Lane | Owns | Contract |
|---|---|---|
| A (backend core) | `server/worker.js`, `server/channel.js`, `server/auth.js`, `server/game.js`, `server/eventsub.js`, `cloudflare.config.ts`, `tests/` (the core tests) | This file |
| B (UI) | `index.html`, `admin/index.html`, `src/`, `public/*.js`, the `vite.config.js` inputs | Sections 2, 3, 5, 7 |
| D (uploads) | `server/uploads.js`, `public/assets/characters.json`, assets, `docs/ASSET_LICENSES.md` | Section 5 and the signatures below |
| E (developer) | `server/developer.js`, `server/ranklog.js`, `server/backups.js`, `admin/dev/index.html` | The signatures below |

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
bun run check              # format:check + lint + typecheck + test:unit (pre-commit hook, CI, deploy.yml)
gitleaks git --config .gitleaks.toml --redact .   # secret scan; CI scans the whole history on every push
bun run audit              # bun audit --audit-level=high; CI fails on a high or critical advisory
bun run format             # oxfmt (.oxfmtrc.json); format:check only reports
bun run lint               # oxlint --deny-warnings, type-aware (.oxlintrc.json)
bun run typecheck          # tsc over the JS: tsconfig.worker.json, tsconfig.web.json, tsconfig.node.json
bun run test:unit          # node --import ./tests/register.mjs --test "tests/*.test.mjs"
bunx cf build              # production build ("Build complete"; ignore the Docker error)
bunx cf build --mode test
bunx cf dev                # local only; reads .dev.vars. Never deploy from a lane.
bun run test:all           # everything below, in order (scripts/test-all.mjs)
```

- `MINI_PORT` (default 5173) and `MINI_PERSIST` (a local state folder) are read by `vite.config.js`, so
  `MINI_PORT=5199 MINI_PERSIST=.cloudflare/e2e-state bunx cf dev` runs beside another dev server.
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
  `cf` or the dashboard (docs/LIVE_FIX.md); they are not declared, because declared secrets are
  required at deploy time. `CHANNEL_ORIGINS` (JSON text from `channelDomains`; left out under
  `MINI_LOCAL_TEST=1`), `CHAT_BOT` and `BOT_LOGIN` (from `site.config.js` `bot`, per environment),
  and on the test site only `BOT_DEBUG` and the secret `DEV_TOOLS_TOKEN`.
