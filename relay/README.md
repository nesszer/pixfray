# mini-chat Windows relay

The relay runs on the OBS PC. It reads nesszerra's Twitch chat through EventSub WebSocket and
forwards game commands to the Worker over one WebSocket (`/api/relay/nesszerra`). Using one socket
keeps request usage within Cloudflare Free. Twitch tokens and the relay credential are stored on this
PC only, encrypted with Windows DPAPI for your Windows account. Tokens are never sent to the Worker.

## Requirements

- Windows 10 or 11 with Windows PowerShell 5.1 (built in). DPAPI runs through `dpapi.ps1`.
- Node.js 22.18 or later on `PATH` (`node -v`).
- OBS Studio 28 or later (for the start/stop script).
- A Twitch Developer app for the relay. Use a separate app with **Client Type: Public**. The device
  login then needs no client secret and no redirect URL. You can reuse the Worker's Confidential app
  instead, but then the secret must be on this PC (see step 3).

## Setup

1. Install the dependency (only `ws`):
   ```
   cd relay
   npm install
   ```
2. **Pair with the site.** Sign in as nesszerra on the admin page and create a relay pairing code
   (`POST /api/relay/code`; the code is valid for 5 minutes and works once). Then run:
   ```
   node index.mjs pair <code>
   ```
   Add `--origin https://test.chat.miolaf.xyz` to pair with the test Worker. The relay stores a
   90-day credential. Revoking it on the admin page closes the relay (code 4003); pair again with a
   new code afterwards.
3. **Link Twitch.** Run:
   ```
   node index.mjs login --client-id <relay app client id>
   ```
   Open the URL it prints in a browser signed in as nesszerra, check that the code matches, and
   approve `user:read:chat`. For a Confidential app, set `MINI_CHAT_TWITCH_CLIENT_SECRET` in that
   terminal first; don't pass the secret as an argument.
4. **Test it by hand.** Run `node index.mjs run`. You should see `[twitch] subscribed` and
   `[backend] connected`. Type `!strike` in chat; a rejected command prints its reason (for
   example `not_in_active_duel`). Stop it with Ctrl+C or `node index.mjs stop`.
5. **Start and stop with OBS.** In OBS, open Tools > Scripts, click `+`, and choose
   `relay\obs\mini-chat-relay.lua`. Keep "Start the relay when OBS starts" checked. Set "Node path"
   only if `node.exe` is not on `PATH`. The script:
   - runs `node index.mjs run --watch-pid <OBS pid>` without a console window when OBS loads it;
   - runs `node index.mjs stop` when OBS exits, so the relay sends `offline` and the Worker pauses
     combat at once;
   - covers an OBS crash: the relay notices that the OBS process is gone within about 1 s and exits.
   It also has "Start relay now" and "Stop relay" buttons.

## Commands

| Command | Effect |
|---|---|
| `pair <code> [--origin URL]` | Exchanges a one-time code for the relay credential |
| `login [--client-id ID]` | Twitch device login for `user:read:chat` |
| `run [--watch-pid PID]` | Runs the relay. Only one instance runs; a second `run` exits at once |
| `stop` | Asks the running relay to go offline and exit (waits up to 5 s) |
| `status` | Shows pairing, linked account and whether the relay is running (no secrets) |
| `unpair`, `logout` | Removes the credential or the Twitch tokens from this PC |

Files live in `%LOCALAPPDATA%\MiniChatRelay` (override with `MINI_CHAT_RELAY_HOME`):
`config.dpapi` (encrypted), `relay.log` (the last 100 status events, no chat text or secrets),
`relay.pid` and `relay.control` (used by `run` and `stop`).

## How it behaves

- **Forwarding.** Messages matching the contract regex (`!duel @user`, `!challenge`, `!accept`,
  `!decline`, `!attack`, `!strike`, `!heavy`, `!heal`, each with an optional `@target`) are sent as
  `command`. Other chat is sent as `presence`, at most once per viewer every 30 s, so a viewer's
  character appears after their first message without a frame for every line.
- **Duplicates and stale messages.** Twitch redeliveries (same EventSub message id) are dropped.
  Messages older than 60 s or more than 10 s in the future are dropped, matching the server.
- **Heartbeat.** The relay sends a heartbeat as soon as the Worker says `hello`, then every
  `heartbeatMs` (10 s). The server only marks the relay connected after that first heartbeat.
- **Twitch outages.** A short EventSub reconnect does not cancel duels. If Twitch stays down for
  more than 15 s, the next heartbeat reports `twitchConnected:false`. The Worker then cancels open
  duels and closes the socket (1012), and the relay reconnects once Twitch is back.
- **Reconnects.** Both sockets reconnect with exponential backoff and full jitter (1 s base, 60 s
  cap). EventSub `session_reconnect` moves to the new URL without resubscribing, and the old
  socket closes only after the new welcome. A missed keepalive (timeout + 5 s) forces a reconnect.
  Up to 100 events (45 s max age) are queued while the Worker socket reconnects.
- **Stops.** Worker close 4003 (credential revoked), 4001 (another relay took over), or a 401/403
  on connect stop the relay with a message. Pair again, or close the other relay.
- **Tokens.** The token is validated at start and every hour, and refreshed when it is near expiry
  or rejected; the new tokens are saved encrypted. An EventSub revocation triggers one refresh and
  resubscribe attempt; if that fails, run `login` again.

## Tests

```
cd relay
npm test            # node --test "../tests/relay-*.test.mjs"
```

The tests cover EventSub parsing, command filtering (checked against `server/game.js`), backoff,
the DPAPI round trip (skipped without Windows PowerShell), and integration runs against local fake
Twitch, EventSub and Worker servers. The integration runs cover forwarding, Worker drop and
reconnect, EventSub migration and reconnect, a Twitch outage, token refresh, revocation, and the
full CLI flow (`pair`, `login`, `run`, `stop`, `--watch-pid`).

## Known limits

- Requests from scripts to the live domain have been blocked with Cloudflare error 1010. The relay
  sends a `User-Agent` header (`MiniChatRelay/2.0`) on `pair` and on the WebSocket, but this has not
  been checked against the live zone. If `pair` or `run` gets 1010, add a WAF skip rule (Browser
  Integrity Check) for `/api/relay/*`.
- The local `vite` dev server hangs up on a rejected WebSocket upgrade instead of returning 403. On
  the local server, a bad credential therefore retries with backoff instead of stopping.
- The OBS Lua script passes a syntax check but has not been run inside OBS yet.
