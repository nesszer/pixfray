# Development

## Run it locally

Requires [Bun](https://bun.sh) 1.4+ and Node 22.18+. Bun installs the packages and runs the
scripts; the tools themselves (`cf`, Vite, Playwright, the tests) run on Node.

```bash
bun install
```

`bun install` also points git at the hooks in `.githooks/` (`scripts/install-hooks.mjs`). Before
each commit they run [gitleaks](https://github.com/gitleaks/gitleaks) over the staged changes and
`bun run check`; before each push they scan the commits being pushed for secrets. Install gitleaks
first (`winget install Gitleaks.Gitleaks`, `brew install gitleaks`), or the hooks refuse.
`git commit --no-verify` skips them once; the push scan and CI still catch a secret.

Create `.dev.vars` in the repo folder with throwaway local values (never your deployed secrets):

```bash
printf 'AUTH_SECRET=%s\nINTERNAL_SECRET=%s\nTWITCH_CLIENT_ID=local-dev-client-id\nTWITCH_CLIENT_SECRET=local-dev-client-secret\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .dev.vars
```

On Windows, `pwsh -NoProfile -File scripts/configure-twitch.ps1` writes it for you. Then:

```bash
bun run dev
```

- Open http://127.0.0.1:5173.
- `/overlay.html?demo=1&arena=1` shows the overlay with fake chatters.
- Twitch sign-in needs a real Twitch app and a public https site, so it only works once deployed.

## Format, lint and types

`bun run check` runs everything below plus the unit tests. The pre-commit hook runs it, and CI
(`.github/workflows/ci.yml`) runs it on every push to `main` and every pull request, next to a
gitleaks scan of the whole history. The deploy workflow runs it before uploading a version.

- `bun run format` formats the code with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`,
  120 columns); `bun run format:check` only reports. HTML, Markdown and `public/assets` are left alone.
- `bun run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with type-aware rules
  (`.oxlintrc.json`). Warnings fail it. In `server/` every promise must be awaited or handed to
  `waitUntil`, because the Worker can cancel one that is dropped.
- `bun run typecheck` runs `tsc` over the plain JavaScript: `tsconfig.worker.json` (server/, Workers
  types), `tsconfig.web.json` (src/ and public/, DOM types plus `types/browser.d.ts`) and
  `tsconfig.node.json` (the build configs). Tests and scripts are linted but not type checked.
  Where inference falls short, add JSDoc (`/** @param {{ … }} opts */`) rather than casting the
  problem away; the code stays `.js`.
- The one whole-repo format commit is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## Tests

`bun run test:all` runs:

- `bun run check` (format, lint, types and the unit tests; `bun run test:unit` on its own),
- both builds and the workerd upload test,
- the browser tests,
- a local end-to-end duel against a `cf dev` it starts on port 5199 with its own state folder.

The end-to-end test signs EventSub webhooks with the `AUTH_SECRET` from `.dev.vars`. `MINI_PORT`
and `MINI_PERSIST` change the dev port and the local state folder.

### Live test

`bun run test:live` plays real duels through Twitch chat on a live deployment.

- It needs two Chromes with remote debugging, each signed in to Twitch and PixFray (`LIVE_A_CDP`,
  `LIVE_B_CDP`).
- It refuses to post while the channel (`LIVE_CHANNEL`) is live.
- It changes both accounts' ranks.

## README banner

[banner.svg](banner.svg) is built by `python scripts/readme-banner.py` (needs Pillow) from the
knight and ninja sprites.
