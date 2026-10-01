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

## Cloudflare
`cf auth login`, `npm run build`, `npm run deploy`.
Assets-only Worker on Workers Free. No database, Durable Object, R2 subscription, AI service or paid plan required.

## Alpha boundary
Uses anonymous read-only Twitch IRC over WebSocket. Real anonymous connection to #nesszerra was verified during development. Twitch documents token-based IRC authentication and recommends EventSub/API; anonymous access may change. public/chat.js isolates that adapter for later replacement.

No shared viewer editor, moderator dashboard, economy or combat yet. The next step is authenticated events and a SQLite Durable Object on Workers Free for shared profiles.

## License
MIT software; CC0 character artwork. See ASSET_LICENSES.md. No Twitch/OBS credentials are included.

See VALIDATION.md for verification and ORACLE_REVIEW.md for second-model consultation.
