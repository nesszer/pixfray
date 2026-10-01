# Mini Chat
Open-source Twitch mini-character overlay for nesszerra. Transparent Canvas rendering, five free Kenney characters, local appearance preferences, reconnect, and demo mode.

Live: https://chat.miolaf.xyz

OBS: https://chat.miolaf.xyz/overlay.html?channel=nesszerra&size=64&cap=50

## Use
Requires Node 22.18+. Run `npm install` then `npm run dev`. Open http://127.0.0.1:5173 and copy the generated URL into an OBS Browser Source at 1920×1080, 30 FPS.

Commands:
- `!jump` — jump with a 3-second cooldown.
- `!avatar adventurer` — IDs: adventurer, female, player, soldier, zombie.
- `!color #ff8844` — nameplate color.

First chat message spawns a character; 10 minutes of inactivity hides it. Appearance persists in that OBS browser's localStorage, not across devices.

Query options: channel, demo=1, debug=1, cap=1..100, size=32..96.

## V2 (local, not deployed yet)
The working tree also holds v2. It adds:
- Twitch sign-in profiles and a viewer dashboard (`/`).
- Mod controls with a versioned balance editor (`/admin/`).
- An owner-only live-fix page (`/admin/dev/`).
- Shared server-decided duels on the overlay (add `arena=1`).
- 15 Kenney CC0 characters and custom character uploads.
- Chat through a Twitch EventSub webhook to the Worker, so nothing runs on the OBS PC. The owner
  signs in with `/auth/login?connect=1` and clicks Connect chat on `/admin/` (TWITCH_SETUP.md).

Chat commands for v2 duels:
- `!challenge @viewer`, then `!accept` or `!decline` (`!fight` when chat goes through StreamElements, whose Duel module owns `!accept`).
- `!attack`, `!strike`, `!heavy`, `!heal`.

Rules and routes are in CONTRACTS.md. The plan and the open gaps are in HANDOFF.md.

Tests: `npm run test:all` runs these in order:
1. Unit tests.
2. `cf build`.
3. `cf build --mode test`.
4. The workerd upload test.
5. The browser tests and the local end-to-end duel, against a `cf dev` it starts on port 5199 with
   its own state folder, seeded test sessions and `MINI_LOCAL_TEST=1`. The end-to-end test sends
   signed EventSub webhooks, using the `AUTH_SECRET` from `.dev.vars` (or `MINI_AUTH_SECRET`).

VALIDATION_V2.md has the commands and the spec audit. `MINI_PORT` and `MINI_PERSIST` change the dev
port and the local state folder.

## Cloudflare
`cf auth login`, `npm run build`, `npm run deploy`.
Live v1 is an assets-only Worker on Workers Free. V2 adds two SQLite Durable Objects (ChannelRoom, AuthStore), still on Workers Free with no paid products.

## Alpha boundary
Uses anonymous read-only Twitch IRC over WebSocket. Real anonymous connection to #nesszerra was verified during development. Twitch documents token-based IRC authentication and recommends EventSub/API; anonymous access may change. public/chat.js isolates that adapter for later replacement.

The live v1 has no shared viewer editor, moderator dashboard or combat. Those are in v2 above, which uses SQLite Durable Objects on Workers Free.

## License
MIT software; CC0 character artwork. See ASSET_LICENSES.md. No Twitch/OBS credentials are included.

See VALIDATION.md for verification and ORACLE_REVIEW.md for second-model consultation.
