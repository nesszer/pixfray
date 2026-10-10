# Owner page developer tools and deploy flow

Who reads this: the owner (nesszerra) setting up and using the **Developer tools** section of the
owner page (`/admin/dev/`) to fix the live game without a laptop build. The top of that page is
for the sign-up link and following each streamer's setup; the tools below are folded until opened. What's needed: which secrets to add, how a fix reaches production, and how
to undo it.

**How releases work today (2026-10-06):** from a local checkout, with the `gh` and `cf`
command-line tools. Deploy to staging with `bunx cf deploy --mode test`, check
https://staging.pixfray.xyz, then deploy to production with `bunx cf deploy`. GitHub isn't set up
on the Worker, so the owner page hides the code editor and release steps and shows this flow
instead. The rest of this file describes the in-browser flow for when `GITHUB_TOKEN` is set.

**Status on 2026-10-03:** the site is deployed (now https://pixfray.xyz), and the project's git
`origin` is https://github.com/nesszer/pixfray.git. The flow below has only been tested
against mocked APIs, and this file doesn't record whether `GITHUB_TOKEN`, the Cloudflare API
token or the Actions secrets are set. Wherever one is missing, the GitHub and Cloudflare
routes answer `501` with `reason: github_not_configured` or
`cloudflare_not_configured`, and the page hides the code editor and release steps. Diagnostics, the error log, live
settings work without any of them.

## The flow

1. **Save to a branch.** In the code editor, pick a branch named `live-fix/<name>` or
   `hotfix/<name>`, load a file, edit it and press **Save to branch**. If the branch doesn't exist,
   it's created from `main` (or `GITHUB_BASE_BRANCH`).
2. **Deploy to test.** **Deploy branch to test** starts `.github/workflows/deploy.yml` with
   `target=test`. The workflow runs `bun run check` (format, lint, types, unit tests), uploads a new version of
   `nesszerra-mini-chat-test` and sends it 100% of test traffic.
3. **Check in OBS.** Point a test browser source at
   `https://staging.pixfray.xyz/overlay.html?channel=nesszerra&arena=1`.
4. **Promote.** Enter the pull request number (use **Open pull request** first) and press
   **Promote to production**. The Worker squash-merges the PR, but only if its base is `main` and
   its head is a `live-fix/` or `hotfix/` branch. Then it starts the workflow with
   `target=production` on the merge commit. A traffic value below 100% does a gradual rollout:
   the new version gets that share and the version currently serving gets the rest.
5. **Roll back.** Choose the site and either "Previous deployment" or a specific version. The
   workflow points 100% of traffic at it. Rollback uploads nothing and runs no build.

**Hotfix:** **Deploy hotfix to production** takes a `hotfix/` branch straight to production. It
skips the test site but still runs the unit tests, then opens a PR so `main` keeps the change.
Merge that PR afterwards, or the next promote from `main` will undo the hotfix.

Recent runs and the versions now serving are listed on the page. Every run name ends with a
request id (`r` + 10 hex digits), so a click can be matched to its run.

## Backups

Cloudflare keeps 30 days of every change to each channel's storage (point-in-time recovery on SQLite
Durable Objects, included on the Free plan). To undo a mistake, such as a rank reset or a bad
setting, open the owner page (`/admin/dev/`), go to **Restore a channel**, pick the channel and the
time, and press **Restore channel**. Everything that channel saved after that time is gone: fighters,
ranks, dollars, settings and its error log. Open overlays and pages reload on their own. **Undo last
restore** puts the channel back to how it was just before the restore. Only that channel moves; the
channel list and sign-ins stay as they are. Restore works on Cloudflare only, not with `bun run dev`.

For a copy you keep yourself, or anything older than 30 days, download the data from the same page:
- **Export** on a channel row: that channel's fighters, ranks, config and config history, the
  metadata of its custom characters (not their images) and the names of its StreamElements
  commands (`mini-chat-<login>-<date>.json`).
- **Export channel list**: the signed-up channels, on and off (`mini-chat-channels-<date>.json`).

Neither file holds StreamElements keys or Twitch tokens. A paused channel can still be exported.

Every day at 09:00 UTC each channel also saves that same export into a D1 database on the Free plan,
kept 90 days. The owner reads it through `/api/dev/backups` (docs/CONTRACTS.md): the days kept for a
channel, the whole export for one day, or one fighter on that day. That last one is the quick way to
put back a single fighter's rank (`restoreRank` on `/api/admin`) without rolling back the whole
channel. `POST /api/dev/backups` saves one now, for example before a risky change.

## Settings to add

### Worker secrets and vars (both Workers: production and test)

| Name | Kind | Required for | Minimum permissions |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | secret | Code editor, PRs, deploy, promote, hotfix, rollback, runs | Fine-grained PAT for **one repo only**: Contents read/write, Pull requests read/write, Actions read/write, Metadata read. **Don't** grant Workflows; without it, the editor also can't change `.github/`. |
| `GITHUB_REPO` | var | Same as above | `owner/name`, for example `nesszer/pixfray` |
| `GITHUB_BASE_BRANCH` | var, optional | Same as above | Defaults to `main` |
| `GITHUB_WORKFLOW` | var, optional | Same as above | Defaults to `deploy.yml` |
| `CF_API_TOKEN` | secret | Request usage, version list | **Read-only** token: Account Analytics Read, Workers Scripts Read |
| `CF_ACCOUNT_ID` | var | Same as above | 32-hex Cloudflare account id |
| `CF_VERSION_METADATA` | `version_metadata` binding, declared in `cloudflare.config.ts` | Showing which version served the page | None |

The other variables and secrets stay out of `cloudflare.config.ts` on purpose, because a declared secret
is required on every deploy. Set them with `cf` or the Cloudflare dashboard.

### GitHub Actions secrets (repo settings, never in the Worker)

| Name | Permissions |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers Scripts Edit on this account (the only token that can deploy) |
| `CLOUDFLARE_ACCOUNT_ID` | The account id |

Optional: create GitHub environments named `test` and `production`, and add required reviewers
to `production` for a second confirmation. The jobs already use `environment: <target>`.

## Before the first use

- Run the **first** deploy of each Worker locally with `cf deploy` (and `cf deploy --mode test`).
  Do the same for any release that adds a Durable Object migration. Version uploads can't apply
  DO migrations, so the workflow isn't the right tool for those.
- `AUTH_SECRET`, `INTERNAL_SECRET` and the Twitch secrets must already be set on each Worker.
  `scripts/release.mjs` checks that the uploaded version has `AUTH_SECRET` and `INTERNAL_SECRET`,
  and refuses to move traffic if either is missing.
- `.github/workflows/ci.yml` runs on every push to `main` and every pull request: `bun run check`,
  `bunx cf build` without credentials, `bun run audit` and a gitleaks scan of the whole history.

## Security limits

- The owner session effectively has push access to the repo. Anyone holding that session can
  change code on a branch and, with a promote, in production. Sign out on shared machines.
- The editor refuses `.dev.vars*`, `.env*`, `.secrets*`, `*.dpapi`, `.github/`, `.git`, `node_modules`, `dist`, `.wrangler` and `.cloudflare`, and files over 512 KB.
- Build files open read-only. Saving one returns 403 `build_file`. Change them from a local checkout.
  - These files run with the deploy workflow's Cloudflare token: `package.json`, `package-lock.json`, `bun.lock`,
    `bunfig.toml`, `.npmrc`, `site.config.js`, `site.config.ts`, `cloudflare.config.ts`,
    `vite.config.{js,mjs,cjs,ts,mts,cts}`, `tsconfig.json`, `tsconfig.<name>.json`, `types/` and `scripts/`.
  - PostCSS config runs during the build: `postcss.config.{js,mjs,cjs,ts,mts,cts}`, `.postcssrc` and
    `.postcssrc.{json,yaml,yml,js,cjs,mjs,ts,cts,mts}`.
  - Wrangler config is refused as a precaution: `wrangler.{json,jsonc,toml}`.
- Code on a `live-fix/` branch runs in CI while `CLOUDFLARE_API_TOKEN` is set on the release step.
  A malicious branch could use that token, so the token is scoped to Workers Scripts Edit only.
- Workflow inputs reach shell steps only through `env`, never through `${{ }}` inside `run:`. The
  workflow also checks that the commit is on the branch it names.
- Mutating `/api/dev/*` requests must be same-origin, and every route returns `403` to anyone but
  the owner. The one exception is the test site's `DEV_TOOLS_TOKEN` (docs/DEVTOOLS.md): it skips the
  same-origin check and counts as the owner, but promote, hotfix and rollback to production return 403
  `owner_session_required`. Production deploys need the owner signed in with Twitch.

## Unverified

The GitHub REST, Cloudflare Workers versions/deployments and GraphQL analytics request shapes
follow the public docs. They were tested only against local fakes (`tests/dev-api.test.mjs`,
`tests/dev-release.test.mjs`), not against the live services. Expect to adjust field names on
the first real run.

## Open items

None. `server/worker.js` awaits `handleDeveloper(...)`, and the optional settings above stay undeclared
by design.
