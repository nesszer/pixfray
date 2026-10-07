# PixFray

```text
██████╗ ██╗██╗  ██╗███████╗██████╗  █████╗ ██╗   ██╗
██╔══██╗██║╚██╗██╔╝██╔════╝██╔══██╗██╔══██╗╚██╗ ██╔╝
██████╔╝██║ ╚███╔╝ █████╗  ██████╔╝███████║ ╚████╔╝
██╔═══╝ ██║ ██╔██╗ ██╔══╝  ██╔══██╗██╔══██║  ╚██╔╝
██║     ██║██╔╝ ██╗██║     ██║  ██║██║  ██║   ██║
╚═╝     ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝

    [o_o]   !challenge @rival    [>_<]
    /|_|\  ------------------->  /|_|\
     / \         !fight          / \
```

PixFray puts a small pixel character on your Twitch stream for each viewer who chats. Viewers pick
and dress their fighter on the website, challenge each other in chat, and the duels play out on the
stream overlay, with Elo ranks, upgrades, hats and pets. It is free and open source (MIT), and runs
on one Cloudflare Worker on the free plan.

Live site: https://pixfray.xyz. The test site is https://staging.pixfray.xyz.

## For streamers: add PixFray to your channel

You need OBS (or another streaming app with a browser source) and a StreamElements account; the
chat commands run as StreamElements custom commands. Nightbot and Fossabot can't run them.

1. Open https://pixfray.xyz/start/ and sign in with the Twitch account you stream on. That turns
   PixFray on for your channel only. It turns on at once for an account that is at least 30 days old
   and is Affiliate or Partner or has a saved past broadcast; any other sign-up waits for the site
   owner's approval.
2. Follow the **Stream setup** checklist on the mod controls page it opens: add the overlay to OBS,
   turn off the StreamElements Duel module, paste the chat commands into StreamElements, and
   optionally let your moderators help.

Setup takes about 10 minutes. [docs/STREAMER_SETUP.md](docs/STREAMER_SETUP.md) walks through each
step and lists fixes for common problems. Up to 200 channels can be signed up on pixfray.xyz. You
can turn PixFray off at any time without losing fighters or ranks.

## How duels work

- `!challenge @viewer`, then the other viewer answers `!fight` or `!decline`. `!rematch` challenges
  the last viewer you fought.
- The duel is rolled at once. Fighters take turns, challenger first, and each swing is a d6: 6 crits
  for 50, 5 hits for 34, 3-4 miss, and on 1-2 the defender counters for 34. Both start at 100 HP.
  After 12 rolls the fighter with more HP wins; equal HP goes to sudden death. A winner who took no
  damage gets +3 Elo.
- The bot only says "Fight on: A vs B! Watch the stream for the winner." The overlay replays the
  duel in about 8-25 s, then shows the Elo change. On a channel with the PixFray chat bot, the bot
  then announces the winner in chat. `!elo`, `!ranks` and the website
  hold back the new numbers until the replay has played (plus the channel's stream delay), so chat
  doesn't spoil the stream.
- Each win earns an upgrade point (power, guard, luck) and unlocks hats. `!checkin`, once per live
  stream, adds a point too, with streak bonuses. Ranked duels pay saved fighters PixFray dollars ($5 a
  win, $3 a loss): `!wallet` shows them, `!pay @name 10` passes them on (`!give` on channels with the
  PixFray chat bot; after 5 finished duels, at most $100 per stream, only while the stream is live), and
  `!pet` shows a fighter's pet. `!fray` explains how to join, and `!look` links to your fighter on the site.
- The same two fighters get 5 ranked duels per rolling 24 hours; after that they still fight, unrated.
  A Twitch account under 7 days old also duels unrated. An unrated duel moves no Elo, wins, losses or
  dollars, and the reply starts "Just for fun". If Twitch can't say how old an account is, the duel is
  ranked.
- Mods tune every number in the balance editor on the mod controls page (versioned and undoable).
  Only the broadcaster (or the site owner) can reset all ranks, make a new StreamElements key, turn
  PixFray off or move chat from another site.

## Pages

- `/`: what PixFray is, with a duel playing. A returning viewer gets a "Back to <channel>" button.
- `/?channel=<login>`: that channel's fighter page. `/play/` picks the channel; `/intro/` redirects to `/`.
- `/start/`: streamer sign-up. `/admin/?channel=<login>`: the mod controls; a signed-in streamer who
  opens `/admin/` lands on their own channel.
- Signing in or out comes back to the same page, channel and tab.

Overlay link options: `channel`, `size=24..96` (clamped; default 60), `cap=1..100` (whole numbers; anything
else means no limit of its own; with `arena=1` the lower of this and the channel's on-stream limit applies),
`arena=1` (duels), `announce=off|top|bottom` (`off`, the default, shows no duel banner; the channel setting in
the mod controls overrides it), `sound=1` (quiet synthesized duel sounds), `bubbles=0` (no speech bubbles: chat messages
or win taunts; duels still show), `fx=off` (no hit glow, sparks or knockout push-in), `demo=1` (a preview with fake
chatters), `debug=1`.

## Run it locally

Requires Node 22.18+.

```bash
npm install
```

Create `.dev.vars` in the repo folder with throwaway local values (never your deployed secrets):

```bash
printf 'AUTH_SECRET=%s\nINTERNAL_SECRET=%s\nTWITCH_CLIENT_ID=local-dev-client-id\nTWITCH_CLIENT_SECRET=local-dev-client-secret\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .dev.vars
```

On Windows, `pwsh -NoProfile -File scripts/configure-twitch.ps1` writes it for you. Then:

```bash
npm run dev
```

Open http://127.0.0.1:5173. `/overlay.html?demo=1&arena=1` shows the overlay with fake chatters.
Twitch sign-in needs a real Twitch app and a public https site, so it only works once deployed.

## Run your own copy

PixFray is one Cloudflare Worker (Workers Free is enough) and one Twitch app.

1. Fork the repo and run `npm install`.
2. Edit `site.config.js`:
   - `owner`: your Twitch login and numeric user id. Only this account opens `/admin/dev`.
   - `builtinChannels` and `defaultChannel`: channels that are always on, and the one used when a
     URL names none. Other streamers turn on their own channel on `/start/`.
   - `workers` and `origins`: your Worker names and the https sites they answer on. Durable Object
     data belongs to the Worker name, so don't rename a Worker that has data.
   - `channelDomains`: a streamer's own domain that opens only their channel. Use `{}` for none.
   - `bot`: the Twitch account of your PixFray chat bot, per site. Leave a site out to run it
     without one; chat then comes in through StreamElements custom commands.
3. Register a Twitch app as in [TWITCH_SETUP.md](TWITCH_SETUP.md), with `<origin>/auth/callback` as
   a redirect URL for every origin and channel domain.
4. Put the deploy secrets in `~/.pixfray/secrets.json`, outside the repo folder: `AUTH_SECRET` and
   `INTERNAL_SECRET` (long random strings, for example `openssl rand -hex 32`),
   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `DEV_TOOLS_TOKEN` for the test site.
5. Run `npx cf auth login`, then `npx cf deploy --mode test --secrets-file ~/.pixfray/secrets.json`.
   Check the test site, then deploy production with the same command without `--mode test`. The
   hosts in `origins` and `channelDomains` must be zones on your Cloudflare account.
6. Sign in on `/admin/` as the owner. Send streamers to `/start/`.

The pages, `robots.txt` and `sitemap.xml` need no edits: they take the site's names and domains
from `site.config.js`. An overlay link without `?channel=` shows `defaultChannel`.

## Tests

`npm run test:all` runs the unit tests, both builds, the workerd upload test, the browser tests and
a local end-to-end duel against a `cf dev` it starts on port 5199 with its own state folder. The
end-to-end test signs EventSub webhooks with the `AUTH_SECRET` from `.dev.vars`. `MINI_PORT` and
`MINI_PERSIST` change the dev port and the local state folder.

`npm run test:live` plays real duels through Twitch chat on a live deployment. It needs two
Chromes with remote debugging, each signed in to Twitch and PixFray (`LIVE_A_CDP`, `LIVE_B_CDP`),
refuses to post while the channel (`LIVE_CHANNEL`) is live, and changes both accounts' ranks.

## Reference

- [CONTRACTS.md](CONTRACTS.md): routes, rules and data formats.
- [docs/STREAMER_SETUP.md](docs/STREAMER_SETUP.md): the streamer checklist.
- [TWITCH_SETUP.md](TWITCH_SETUP.md): the Twitch app and the owner's EventSub chat connection.
- [docs/DEVTOOLS.md](docs/DEVTOOLS.md) and [docs/LIVE_FIX.md](docs/LIVE_FIX.md): the owner page's
  tools. The test site's dev token can't deploy to production or save build files.

Limits: each signed-in user can make 30 changes a minute (more gets 429). Dollars show only to mods and
the owner, and the public `/health` says only ok. Pages send HSTS and a Content-Security-Policy that
allows Cloudflare's analytics beacon; the overlay's allows only the Twitch chat socket. Adding a script
or embed means changing `server/security.js`.

The overlay joins chat over anonymous read-only Twitch IRC to show who is chatting
([public/chat.js](public/chat.js)); Twitch may change anonymous access. Duels and ranks go through
the Worker.

## License

MIT for the software; the character artwork is CC0. See [ASSET_LICENSES.md](ASSET_LICENSES.md).
No Twitch or OBS credentials are included.
