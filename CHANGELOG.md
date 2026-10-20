# Changelog

Code, tooling and operations changes, newest first. What players and streamers notice is on the site's `/changelog/`
page (`changelog/index.html`). Both use the version in `package.json`.

Rules (checked by `tests/changelog.test.ts`):

- The newest version here equals `package.json` `version`, which is what production runs.
- Every release on `/changelog/` has a heading here with the same date. A release with nothing a player or streamer
  would notice appears only here.
- Versions are semver below 1.0: a minor bump for new things players or streamers can see, a patch bump for fixes
  and behind-the-scenes work.
  0.1.0 to 0.7.1 were cut after the fact from git history.

## 0.11.0 - 2026-10-20

- Channel point rewards section on the mod page's Stream setup tab (`renderPoints` in `src/admin.ts`): the
  broadcaster or owner allows the points permission, adds and deletes rewards; mods read rewards and redemptions.
- `GET /api/admin/:channel` returns `pointsReady`, read from the scopes sealed with the stored broadcaster token.

## 0.10.0 - 2026-10-20

- `!changelog` bot and StreamElements command (`changelog` action, a read action). Its line comes from `LATEST_RELEASE`
  in `server/release.ts`; `tests/changelog.test.ts` keeps it equal to the page's newest release.

## 0.9.0 - 2026-10-20

- Level sync: `syncPair` in `server/upgrades.ts` (`SYNC_MARGIN` 10) and `duelStats` in `server/game.ts`, used for
  `duel.maxHp`, quick-duel swings and HP-fight blows.
- Every third ranked loss is an upgrade point (`LOSSES_PER_POINT`). `pointsFor`, `effectiveStats`, `validStats` and
  `upgradeRules` take one `Earned` object instead of separate wins and bonus arguments.

## 0.8.1 - 2026-10-20

- The changelog splits in two: `/changelog/` keeps only what players and streamers notice, and this file holds code
  notes for every release. `tests/changelog.test.ts` checks both against `package.json` (#45).

## 0.8.0 - 2026-10-20

- Channel point backend: the `channel.channel_points_custom_reward_redemption.add` EventSub subscription,
  `createPointReward` and `deletePointReward` admin actions (broadcaster only), idempotent grants and refunds keyed
  by redemption ID, and a per-room redemption log in `server/points.ts` (#43).
- Debug tracing: alarm, duel and chat logs, daily room counters, and `scripts/logs.ts` to read them (#42).
- `/changelog/` page, with `package.json` `version` as the version source (#44).
- `tests/ui.ts` mock config gains `pairRankedPerStream`, missing since #40.

## 0.7.1 - 2026-10-16

- The room tick dropped expired rematch locks without marking the state changed, so the alarm re-armed itself about 8
  times a second (164k alarms in 7 days). Expired locks are now saved (#41).

## 0.7.0 - 2026-10-15

- Upgrade cost model with level costs, stat ceilings and presets in `server/upgrades.ts` (#34, #35, #36).
- The sprite subject finder and background removal run in a Web Worker (#37, #38).
- The bot e2e runs on staging again, room routes are awaited, and shop answers are parsed before use (#39).
- `pairRankedPerStream` config and the live-only ranked check (#40).

## 0.6.2 - 2026-10-12

- Strict TypeScript port of the server, pages, overlay modules, tests, scripts and build config (#11, #16 to #24, #27,
  #28, #31 to #33). `bun run port-check` proves a port PR changes no runtime code.
- Requests, outside answers, stored data and what the browser receives are parsed at the boundary (#25, #29, #30).
- The owner editor refuses config saves (#9, #13); the deploy check job runs without the Cloudflare token (#14);
  rollbacks deploy only from the base branch (#15); `DEV_TOOLS_TOKEN` lives only in the test secrets (#8); pinned
  `@types/three` (#10); stale tests removed (#12).

## 0.6.1 - 2026-10-09

- Changes land by pull request with review (#1); dependency audit and a `sharp` pin (#2).
- Rank history per channel and an owner-only `restoreRank` action (#4 to #6).
- Daily backups of every channel into D1, kept 90 days, with point-in-time restore (#7).
- oxfmt, oxlint and tsc in `bun run check`; CI on every push with gitleaks; pre-commit hooks.

## 0.6.0 - 2026-10-07

- Open-source prep: everything reads `site.config.js`, secrets moved to `~/.pixfray`, gitleaks config, Bun for
  scripts, AGENTS.md and DESIGN.md.
- Hardening: HSTS and a script CSP, durable EventSub dedupe, the public health check says only ok.
- Overlay modules versioned per deploy (`?v=` hash), hashed bundles cached for a year, `/api/picker`.
- The live chat e2e follows the bot account.

## 0.5.0 - 2026-10-06

- Self-hosting from one `site.config.js` (owner, channels, Workers, domains, bot).
- The owner page releases from a local checkout.
- `priceSchema` 2 migration for the shop price cut.
- Channel export through the dev token.

## 0.4.0 - 2026-10-05

- Main site moved to pixfray.xyz and staging to staging.pixfray.xyz.
- The bot reads chat through EventSub and replies through Helix, with 429 retry; a staging debug bot.
- Baked scroll stills for the redesign, and browser tests on the GPU.

## 0.3.0 - 2026-10-04

- Live Twitch chat e2e loop (`bun run test:live`).
- Edge rate limit of 20 requests per 10 seconds.
- Saved-look lookups retry once.

## 0.2.0 - 2026-10-02

- Workers Logs with query strings redacted.
- Security headers and socket caps.
- A re-runnable build script for the CC0 characters.
- Overlay settings come from the server, and overlays reload on deploy.

## 0.1.0 - 2026-10-01

- One Cloudflare Worker with a SQLite Durable Object per channel.
- Twitch EventSub webhooks replace the local chat relay; StreamElements as a second command source.
- Test-site dev tools, command logging, and an overlay clock skew fix.
