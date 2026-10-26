# PixFray agent guide

PixFray is a Twitch overlay and chat game: chatters walk on stream as pixel fighters and duel through chat
commands answered by the PixFray bot. One Cloudflare Worker (`server/worker.ts`) serves the pages and API, and each
channel is a SQLite Durable Object (`ChannelRoom` in `server/channel.ts`). Pages build with Vite from `src/`.

IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. Twitch EventSub, the `cf` deploy CLI and
this codebase change faster than model training data. Explore the code first, then read the doc from the index below
before relying on memory. Don't guess commands, flags or file locations: they are listed here.

## Commands

| Task | Command |
|---|---|
| Install | `bun install` (Bun runs packages and scripts; tools need Node 22.18+) |
| Dev server | `bun run dev`, then http://127.0.0.1:5173 (`.dev.vars` holds throwaway local values only) |
| Before every commit | `bun run check` (format, lint, types, unit tests; the pre-commit hook adds gitleaks) |
| Unit tests | `bun run test:unit` |
| Smoke test | `bun run test` (needs the dev server) |
| Everything | `bun run test:all` (unit, builds, workerd upload, browser tests, local e2e duel) |
| Deploy to staging | `bunx cf deploy --mode test --secrets-file ~/.pixfray/secrets.test.json` |
| Deploy to production | `bunx cf deploy --secrets-file ~/.pixfray/secrets.json` |

It is not wrangler: never `wrangler deploy` or `--env`.

## Rules

- **Staging first.** Every change deploys to staging (`--mode test`) and is checked there. Production needs the
  owner's explicit go for that specific change; an earlier approval doesn't carry over.
- **Changes land by pull request.** Push a branch and open a PR to `main`; CI and CodeRabbit review it. Fix or
  answer every finding, then squash-merge (docs/DEVELOPMENT.md).
- **Secrets stay out of the repo.** Deploy secrets live in `~/.pixfray/secrets.json` (production) and
  `~/.pixfray/secrets.test.json` (the same plus `DEV_TOOLS_TOKEN`; `cf deploy` uploads every key). Never copy them into
  `.dev.vars`, a test, a doc, a commit or command output. `.gitleaks.toml` allowlists only `.dev.vars`.
- **Cloudflare Free only:** SQLite Durable Objects, no paid products.
- **`site.config.js` is the only place** for the owner, built-in channels, domains, Worker names and the bot account.
  Never hard-code a channel, login or domain anywhere else.
- **Real Twitch chat:** post only while that channel is offline. Check
  `curl -s https://decapi.me/twitch/uptime/<login>` (it must say offline) right before posting. `bun run test:live`
  refuses on its own.
- **Every behavior change gets a unit test** in `tests/*.test.ts` and a doc update: routes, rules and config in
  `docs/CONTRACTS.md`; anything a streamer sees in `docs/STREAMER_SETUP.md` or `docs/DUELS.md`.
- **Strict TypeScript.** New code is `.ts` with `.ts` imports, and `bun run typecheck` fails a TS
  file outside the strict programs. Each `any`, `as` or `!` says why on that line or above (docs/DEVELOPMENT.md).
- **Browser tests run headed with GPU flags** via `launchChrome()` in `tests/chrome.ts`. Don't set `HEADLESS=1`.
- **Design:** read `DESIGN.md` before changing any page or the overlay. It documents the system in
  `public/dashboard.css` (tokens, classes, one gold accent, lock-on selection) and the patterns reviews keep catching.
  Claude Code loads it here: @DESIGN.md

## Where things go

- **Channel setting (mods change it on the mod page):** `DEFAULT_CONFIG` in `server/model.ts`,
  `CONFIG_CHECKS` in `server/game.ts`; a `GROUPS` field in `src/admin/rules.ts`; reads in `server/room-*.ts`, `channel.ts`;
  a test with a valid patch and an `invalid_config_<key>` rejection; `docs/CONTRACTS.md` §7.
- **Bot chat command:** `botCommand` or `QUICK_COMMANDS` in `server/room-bot.ts`; names and texts in
  `server/streamelements.ts` (`botNames()`, `DEFAULT_SE_NAMES`, `se*Text`). Mods' own text commands are
  `server/botcommands.ts`.
- **Who is a mod in chat:** `ev.mod`, set once from the badges (`MOD_BADGES`: broadcaster, moderator,
  lead_moderator) in `slimEvent` in `server/eventsub.ts`.
  Don't read badges anywhere else. Admin-page access is a separate Helix check in `server/auth.ts`.
- **Refusing the bot as a target:** the single `BOT_TARGET_ACTIONS` check in `server/room-bot.ts`. Keep it one check;
  the bot may become a co-op boss later.

## Known failure patterns

Each one has happened here. Check for it by name before calling work done.

1. **Lead-mod blind spot:** Twitch gives a lead moderator only the `lead_moderator` badge, not `moderator`.
   Mod checks go through `MOD_BADGES`.
2. **Prod first:** deploying to production before staging, or on a stale approval.
3. **Guessed deploy:** `wrangler`, `--env staging` or a made-up secrets path instead of the commands above.
4. **Domain leak:** a production deploy claiming a custom domain that another Worker serves. `channelDomains` stays
   empty unless the owner says otherwise.
5. **Expired session read as a broken deploy:** the `mini_session` cookie lasts 30 days, so a 401 from
   `/api/admin` after a deploy usually means sign in again.
6. **Duplicate chat line:** Twitch drops a message identical to the same user's previous one within 30 s (a trailing
   space doesn't make it different). Live tests vary their lines.
7. **Hidden chat tab:** Twitch chat ignores input in a background tab, and Playwright's `connectOverCDP` lands in an
   ad iframe on popout chat. Drive chat with raw CDP plus `Emulation.setFocusEmulationEnabled`.
8. **Winner banner:** the overlay shows no winner banner; the bot names the winner in chat.

## Docs index

```
[Design]|DESIGN.md: readers, copy, tokens, motion, overlay, primitives, avoid list, verify
[PixFray docs]|root: ./docs
|README.md: map of these docs
|STREAMER_SETUP.md: sign-in, OBS overlay, the bot, mods, viewer sprites, StreamElements, troubleshooting, turning off
|DUELS.md: chat commands, duel rolls, dollars, ranked vs unrated, mod and broadcaster controls
|PAGES.md: every page and overlay URL option (channel size cap arena announce sound bubbles fx demo debug)
|CONTRACTS.md: §1 conventions|§2 routes, registry, admin actions|§3 /api/live|§4 /api/eventsub|§5 characters|§6 game rules|§7 config|§8 modules, signatures|§9 tests, build
|TWITCH_SETUP.md: Twitch app, EventSub chat, PixFray bot account
|SELF_HOSTING.md: site.config.js, Twitch app, secrets, deploy, limits
|DEVELOPMENT.md: local dev, test suites, TypeScript programs, live chat env vars
|DEVTOOLS.md: test-site tools (bot fighters, scripted duels, alt account in real chat, OBS)
|LIVE_FIX.md: release flow, owner page fix/deploy/rollback, backups
|ASSET_LICENSES.md, CHARACTER_RESERVE.md: character and font sources|PROGRESSION_PLAN.md: historical
[Code]|server/: worker.ts routes|http.ts replies|channel.ts ChannelRoom|room-routes.ts routes, admin|room-bot.ts chat|room-economy.ts shop|room-shared.ts|game.ts rules, config|eventsub.ts webhooks, slimEvent, sendChat|auth.ts sessions, Helix mod checks|channels.ts registry|botcommands.ts|streamelements.ts|uploads.ts sprites.ts developer.ts security.ts ratelimit.ts dedupe.ts tracker.ts points.ts upgrades.ts pets.ts cosmetics.ts
|src/: admin.ts admin/ mod page|dashboard.ts dashboard/ fighter page|start.ts sign-up|setup.ts|intro/ home page 3D|scrub.ts|sprite-maker.ts spritify.ts autosprite.ts|fighter3d.ts voxthumb.ts
|src/served/: overlay.ts entry, overlay-*.ts|pixels.ts canvas|text.ts helpers|arena-client.ts|chat.ts IRC|public/: overlay.html|dashboard.css tokens
|tests/: *.test.ts unit|fakes.ts worker-fakes.ts doubles|smoke.ts|ui.ts arena-browser.ts|e2e-local.ts|chrome.ts
|scripts/: strict-check.ts|devtools.ts|logs.ts|release.ts|live-chat-e2e.ts|test-all.ts|configure-twitch.ps1
```

## Changing this file

Add a rule when an agent repeats a mistake or a review catches what it should have known. Put it in
the narrowest place that enforces it: a test or code check first, this file for judgment. Name new failure
patterns in the list above. Keep this file under 8 KB and the index pointing at real files.
