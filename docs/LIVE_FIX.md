# Owner page developer tools and deploy flow

Who reads this: the owner (nesszerra) setting up and using the **Developer tools** section of the
owner page (`/admin/dev/`) to fix the live game without a laptop build. The top of that page is
for inviting streamers and following their setup; the tools below are folded until opened. What's needed: which secrets to add, how a fix reaches production, and how
to undo it.

**Status on 2026-10-03:** the site is deployed (https://chat.miolaf.xyz), and the project's git
`origin` is https://github.com/Finesssee/mini-chat.git. The flow below has only been tested
against mocked APIs, and this file doesn't record whether `GITHUB_TOKEN`, the Cloudflare API
token or the Actions secrets are set. Wherever one is missing, the GitHub and Cloudflare
routes answer `501` with `reason: github_not_configured` or
`cloudflare_not_configured`, and the page disables those buttons. Diagnostics, the error log, live
settings work without any of them.

## The flow

1. **Save to a branch.** In the code editor, pick a branch named `live-fix/<name>` or
   `hotfix/<name>`, load a file, edit it and press **Save to branch**. If the branch doesn't exist,
   it's created from `main` (or `GITHUB_BASE_BRANCH`).
2. **Deploy to test.** **Deploy branch to test** starts `.github/workflows/deploy.yml` with
   `target=test`. The workflow runs the unit tests, uploads a new version of
   `nesszerra-mini-chat-test` and sends it 100% of test traffic.
3. **Check in OBS.** Point a test browser source at
   `https://test.pixfray.xyz/overlay.html?channel=nesszerra&arena=1`.
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

There is no automatic backup. Before a risky change, open the owner page (`/admin/dev/`) and
download the data:
- **Export** on a channel row: that channel's fighters, ranks, config and config history, the
  metadata of its custom characters (not their images) and the names of its StreamElements
  commands (`mini-chat-<login>-<date>.json`).
- **Export channel list**: the channels that are on and the invites (`mini-chat-channels-<date>.json`).
  Invite tokens are left out.

Neither file holds StreamElements keys or Twitch tokens. A paused channel can still be exported.

## Settings to add

### Worker secrets and vars (both Workers: production and test)

| Name | Kind | Required for | Minimum permissions |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | secret | Code editor, PRs, deploy, promote, hotfix, rollback, runs | Fine-grained PAT for **one repo only**: Contents read/write, Pull requests read/write, Actions read/write, Metadata read. **Don't** grant Workflows; without it, the editor also can't change `.github/`. |
| `GITHUB_REPO` | var | Same as above | `owner/name`, for example `Finesssee/mini-chat` |
| `GITHUB_BASE_BRANCH` | var, optional | Same as above | Defaults to `main` |
| `GITHUB_WORKFLOW` | var, optional | Same as above | Defaults to `deploy.yml` |
| `CF_API_TOKEN` | secret | Request usage, version list | **Read-only** token: Account Analytics Read, Workers Scripts Read |
| `CF_ACCOUNT_ID` | var | Same as above | 32-hex Cloudflare account id |
| `CF_VERSION_METADATA` | `version_metadata` binding, optional | Showing which version served the page | None |

These bindings aren't declared in `cloudflare.config.ts` yet. That file belongs to the Core lane;
see "Open items" below.

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
- `.github/workflows/ci.yml` runs `npx cf build` without credentials. That hasn't been tried on a
  GitHub runner yet. If it fails, drop that step; the unit tests remain.

## Security limits

- The owner session effectively has push access to the repo. Anyone holding that session can
  change code on a branch and, with a promote, in production. Sign out on shared machines.
- The editor refuses `.dev.vars*`, `.env*`, `.secrets*`, `*.dpapi`, `.github/`, `.git`, `node_modules`, `dist`, `.wrangler` and `.cloudflare`, and files over 512 KB.
- Code on a `live-fix/` branch runs in CI while `CLOUDFLARE_API_TOKEN` is set on the release step.
  A malicious branch could use that token, so the token is scoped to Workers Scripts Edit only.
- Workflow inputs reach shell steps only through `env`, never through `${{ }}` inside `run:`. The
  workflow also checks that the commit is on the branch it names.
- Mutating `/api/dev/*` requests must be same-origin, and every route returns `403` to anyone but
  the owner.

## Unverified

The GitHub REST, Cloudflare Workers versions/deployments and GraphQL analytics request shapes
follow the public docs. They were tested only against local fakes (`tests/dev-api.test.mjs`,
`tests/dev-release.test.mjs`), not against the live services. Expect to adjust field names on
the first real run.

## Open items for other lanes

- `cloudflare.config.ts`: declare the optional bindings above.
- `server/worker.js`: use `return await handleDeveloper(...)` so errors thrown inside reach its
  `catch`. `developer.js` already catches its own errors.
