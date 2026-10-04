# PixFray
Open-source Twitch mini-character overlay for nesszerra and other channels. Transparent Canvas rendering, 56 free CC0 characters, chat duels with Elo ranks, and demo mode.

Live: https://pixfray.xyz (deployed on Cloudflare Workers Free; the test site is staging.pixfray.xyz).
https://chat.miolaf.xyz is miolafff's own domain: it opens her channel, and other channels' pages move to
pixfray.xyz. Older OBS and StreamElements links on chat.miolaf.xyz keep working.

OBS: https://pixfray.xyz/overlay.html?channel=nesszerra&size=64&cap=50

## Use
Requires Node 22.18+. Run `npm install` then `npm run dev`. Open http://127.0.0.1:5173 and copy the generated URL into an OBS Browser Source at 1920×1080, 30 FPS.

Commands:
- `!jump` — jump with a 3-second cooldown.
- `!avatar adventurer` — any character ID the overlay has loaded, for example adventurer, female, player, soldier or zombie (the dashboard lists them all).
- `!color #ff8844` — nameplate color.

First chat message spawns a character; 10 minutes of inactivity hides it. Appearance persists in that OBS browser's localStorage, not across devices.

Query options: channel, demo=1, debug=1, cap=1..100, size=32..96.

## V2 (deployed)
V2 replaced v1 on https://chat.miolaf.xyz on 2026-10-01. The commands above are the v1 overlay; v2 adds:
- Twitch sign-in profiles and a viewer dashboard (`/`).
- Mod controls with a versioned balance editor (`/admin/`).
- An owner page (`/admin/dev/`): invite streamers, follow their setup, read error logs, and folded developer tools.
- Shared server-decided duels on the overlay (add `arena=1`).
- 56 CC0 characters (Kenney, pzUH, Sogomn) and custom character uploads (up to 24 per channel).
- Chat through a Twitch EventSub webhook to the Worker (nesszerra only) or through StreamElements custom
  commands (every other channel), so nothing runs on the OBS PC. The owner signs in with
  `/auth/login?connect=1` and clicks Connect chat on `/admin/` (TWITCH_SETUP.md).

Chat commands for v2 duels:
- `!challenge @viewer`, then `!fight` (or `!accept`) or `!decline`. Use `!fight` with StreamElements, whose Duel module owns `!accept`.
- `!rematch` challenges the last viewer you fought; if they answer `!rematch` (or `!fight`), the duel starts. The 30 s
  rematch lock still applies.
- Accepting rolls the duel at once (quick duels, the default). Fighters take turns, challenger first, and each swing is a d6:
  6 crits for 50, 5 hits for 34, 3-4 misses, and on 1-2 the defender counters for 34. Both start
  at 100 HP. After 12 rolls the fighter with more HP wins; equal HP goes to sudden death, where
  the next blow wins. A winner who took no damage gets +3 Elo on top. The bot replies only "Fight on: A vs B! Watch
  the stream for the winner.", and the overlay replays the duel in about 8-25 s and then announces
  the winner and the Elo change. `!elo`, `!ranks` and the website show the old numbers until the
  replay has played on stream (plus the channel's stream delay, 6 s by default and set in the admin Rules tab), so chat replies and ranks don't spoil the stream. The overlay itself gets the result at once, so someone who opens the overlay page can see it early. The default ability only changes how blows look. Each win earns an upgrade point
  (power, guard, luck) and unlocks hats. `!checkin`, once per live stream, adds a point too, with
  streak bonuses; 20 points in all, 8 per stat. Each finished duel pays PixFray dollars ($5 a win,
  $3 a loss): `!wallet` shows them, `!pay @name 10` passes them on while the stream is live, and
  mods gift them from the Players tab. See CONTRACTS.md section 6. The HP fight with `!strike`,
  `!heavy` and `!heal` runs only if a mod's config sets `quickDuel` to false.
- Overlay option `sound=1` plays quiet duel sounds (synthesized in the browser, no audio files).

Adding a streamer: on `/admin/dev` (Channels), type their Twitch login and send them the invite
link. They sign in on `/start/` and follow the Stream setup checklist; docs/STREAMER_SETUP.md walks
through it. nesszerra and miolafff are built in; up to 200 invited channels can be on, and each one
can be turned off by its streamer or the owner without losing fighters or ranks.

Rules and routes are in CONTRACTS.md. The plan and the open gaps are in HANDOFF.md.

Tests: `npm run test:all` runs these in order:
1. Unit tests.
2. `cf build`.
3. `cf build --mode test`.
4. The workerd upload test.
5. The browser tests and the local end-to-end duel, against a `cf dev` it starts on port 5199 with
   its own state folder, seeded test sessions and `MINI_LOCAL_TEST=1`. The end-to-end test sends
   signed EventSub webhooks, using the `AUTH_SECRET` from `.dev.vars` (or `MINI_AUTH_SECRET`).

`npm run test:live` is separate and runs against prod through real Twitch chat and the StreamElements
bot. It needs two headed Chromes with remote debugging, each signed in to Twitch and PixFray with a
saved fighter: the broadcaster on port 9333 and a second account on 9334 (`LIVE_A_CDP`, `LIVE_B_CDP`).
It refuses to post while the channel (`LIVE_CHANNEL`, default nesszerra) is live. Both accounts send
every command and every refusal (no name, self, no fighter, busy, wrong challenger, rematch lock,
expired challenge), and play two duels (a named `!fight` and a mutual challenge). Each bot reply must
show in both chat tabs, each duel reply must hide the result, the leaderboard must not change until
the stream has played the duel and must then match it, and the overlay must show the second
account's saved look and play both duels. The duels change both accounts' Elo, wins and losses. It
takes about 5 minutes. The log and screenshots of the overlay and both chats go to
`../../work/live-e2e/` (`LIVE_OUT`).

VALIDATION_V2.md has the commands and the spec audit. `MINI_PORT` and `MINI_PERSIST` change the dev
port and the local state folder.

## Cloudflare
`cf auth login`, `npm run build`, `npm run deploy`.
The live site is one Worker on Workers Free with two SQLite Durable Objects (ChannelRoom, AuthStore) and no paid products. Prod is `nesszerra-mini-chat`; the test site is `nesszerra-mini-chat-test` (`npm run deploy -- --mode test`).

## Alpha boundary
Uses anonymous read-only Twitch IRC over WebSocket. Real anonymous connection to #nesszerra was verified during development. Twitch documents token-based IRC authentication and recommends EventSub/API; anonymous access may change. public/chat.js isolates that adapter for later replacement.

The overlay still joins chat over anonymous read-only IRC (unless `demo=1`) to show who is chatting. Duels, ranks and the commands for them go through the Worker.

## License
MIT software; CC0 character artwork. See ASSET_LICENSES.md. No Twitch/OBS credentials are included.

VALIDATION_V2.md is the current verification record and HANDOFF.md the current state. VALIDATION.md and ORACLE_REVIEW.md are v1-era records kept for history.
