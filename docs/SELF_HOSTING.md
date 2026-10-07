# Run your own copy

PixFray is one Cloudflare Worker (Workers Free is enough) and one Twitch app.

## 1. Get the code

Fork the repo and run `bun install`.

## 2. Edit `site.config.js`

| Setting | What to put there |
|---|---|
| `owner` | Your Twitch login and numeric user id. Only this account opens `/admin/dev`. |
| `builtinChannels` | Channels that are always on. Other streamers turn on their own channel on `/start/`. |
| `defaultChannel` | The channel used when a URL names none. |
| `workers`, `origins` | Your Worker names and the https sites they answer on. Durable Object data belongs to the Worker name, so don't rename a Worker that has data. |
| `channelDomains` | A streamer's own domain that opens only their channel. Use `{}` for none. |
| `bot` | The Twitch account of your PixFray chat bot, per site. Leave a site out to run it without one; chat then comes in through StreamElements custom commands. |

## 3. Register a Twitch app

Follow [TWITCH_SETUP.md](TWITCH_SETUP.md), with `<origin>/auth/callback` as a redirect URL for
every origin and channel domain.

## 4. Store the secrets

Put the deploy secrets in `~/.pixfray/secrets.json`, outside the repo folder:

- `AUTH_SECRET` and `INTERNAL_SECRET`: long random strings, for example `openssl rand -hex 32`.
- `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.
- `DEV_TOOLS_TOKEN`, for the test site only.

## 5. Deploy

```bash
bunx cf auth login
```

```bash
bunx cf deploy --mode test --secrets-file ~/.pixfray/secrets.json
```

Check the test site, then deploy production with the same command without `--mode test`. The hosts
in `origins` and `channelDomains` must be zones on your Cloudflare account.

## 6. Go live

Sign in on `/admin/` as the owner. Send streamers to `/start/`.

The pages, `robots.txt` and `sitemap.xml` need no edits: they take the site's names and domains
from `site.config.js`.

## Limits and security

- Each signed-in user can make 30 changes a minute (more gets 429).
- Dollars show only to mods and the owner, and the public `/health` says only ok.
- Pages send HSTS and a Content-Security-Policy that allows Cloudflare's analytics beacon; the
  overlay's allows only the Twitch chat socket. Adding a script or embed means changing
  `server/security.js`.
- The owner page's tools are in [DEVTOOLS.md](DEVTOOLS.md) and [LIVE_FIX.md](LIVE_FIX.md). The test
  site's dev token can't deploy to production or save build files.
