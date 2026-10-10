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
gitleaks scan of the whole history and `bun run audit`. The deploy workflow runs it before uploading a version.

- `bun run format` formats the code with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`,
  120 columns); `bun run format:check` only reports. HTML, Markdown and `public/assets` are left alone.
- `bun run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with type-aware rules
  (`.oxlintrc.json`). Warnings fail it. In `server/` every promise must be awaited or handed to
  `waitUntil`, because the Worker can cancel one that is dropped.
- `bun run typecheck` runs `tsc` four times. `tsconfig.worker.json` (server/, Workers types),
  `tsconfig.web.json` (src/ and public/, DOM types plus `types/browser.d.ts`) and `tsconfig.node.json`
  (the build configs) check the JavaScript loosely; `tsconfig.strict.json` checks every TypeScript
  file with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Tests and the
  `.mjs` scripts are linted but not type checked. In a `.js` file, add JSDoc where inference falls
  short (`/** @param {{ … }} opts */`) rather than casting the problem away.
- `bun run audit` checks every installed package against the advisory database and fails on a high or
  critical one. When the fix sits behind a dependency that pins the old version, add an exact version to
  `overrides` in `package.json` (as for `sharp`) once that release is 7 days old. Before bumping a package,
  `bun pm diff <pkg>@<old> <pkg>@<new>` shows what its code changed.
- The one whole-repo format commit is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## TypeScript port

The code moves from JSDoc-typed JavaScript to strict TypeScript one file at a time. Node 22.18+ runs
`.ts` scripts with no flags, and Vite and `cf build` strip the types from the pages and the Worker.

- New and ported files are `.ts`, import local files with the `.ts` extension and use only syntax
  that strips to JavaScript (no `enum`, `namespace` or parameter properties; `erasableSyntaxOnly`).
  Type-only imports say `import type` (`verbatimModuleSyntax`).
- Every TypeScript file (`.ts`, `.mts`, `.cts`, `.tsx`, `.d.ts` included) is listed in `files` in
  `tsconfig.strict.json`. Two are checked by another program instead: `cloudflare.config.ts` by
  `tsconfig.node.json` and `types/browser.d.ts` by `tsconfig.web.json`. `bun run check` enforces
  this through `node scripts/port-check.ts --strict-list` in `tests/port-check.test.mjs`, which
  reads every tracked and untracked file that git doesn't ignore.
- Each `any`, `as` cast or `!` assertion says why in a comment on that line or the line above.
- `types/lib-guards.d.ts` lets `Number.isInteger` narrow `unknown` to `number`, so a port needs no
  added `typeof` check, which would change the runtime code. The guard names a branded number, so
  the false branch of `number | undefined` stays `number | undefined`.

A port pull request changes types only, from a `port/<name>` branch:

1. `node scripts/port-rename.ts server/<name>.js` renames the file to `.ts`, points its importers at
   the `.ts` path and updates the repo path in docs, configs and comments. It lists the code strings
   that still name the old path; they are runtime values, so decide on them in their own change.
2. Add types until `bun run typecheck` passes, and add the file to `tsconfig.strict.json`.
3. `bun run port-check` (`node scripts/port-check.ts --base origin/main`) compares every code file
   (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`) that differs between the working
   tree and where the branch left `main`:
   - Pairing. A file pairs with the same path. A file gone at head pairs with a new file of the
     same name, the base name without its code extension: first in the same folder
     (`server/a.js` and `server/a.ts`), then anywhere in the repo (`public/overlay.js` and
     `src/served/overlay.js`). git's rename detection is not used. When more than one gone or new
     file shares a name, the check fails and names them instead of guessing; move or rename such
     files in separate steps. A port keeps each file's name.
   - A gone file with no pair fails. A new file with no pair passes only when it strips to no
     runtime code (types only, such as `server/env.ts`).
   - Comparing. Both versions are stripped to JavaScript with oxc, with comments removed except
     bundler annotations (`/*#__PURE__*/`, `/* @vite-ignore */`, `webpack...:`), which stay.
     A relative import path at head is read as the path the base file would write to reach the
     base version of the same target, so a moved importer or a renamed target is not a
     difference, while `./b.mjs` changed to `./b.js` is.
   - It prints the first differing line of each file with its source line at base and at head,
     then `N files compared, M different` (with `, K other problems` for unpaired, ambiguous and
     strict-list failures), and exits 1 on any of them. A branch that adds runtime code, such as
     a new script, fails it by design: that belongs in a `ts/` branch.

   CI runs it on every push to a `port/` branch and every pull request from one.

A bug the port uncovers (a missing check, a wrong default) gets its own pull request.

## Pull requests and review

Changes reach `main` through a pull request:

1. Commit on a branch (the hooks run), push it and open a PR against `main` (`gh pr create`).
2. CI runs, and [CodeRabbit](https://coderabbit.ai) (free on public repositories) reviews the diff.
   Its settings are in `.coderabbit.yaml`: it reviews against `AGENTS.md` and `DESIGN.md`, runs
   oxlint, gitleaks, actionlint and shellcheck, and warns when a behavior change has no test or
   doc, or when a channel or domain is hard-coded outside `site.config.js`.
   CodeRabbit skips automatic reviews on repositories with fewer than 10 stars, so start each
   review with a PR comment: `@coderabbitai review`. The free plan allows one review per hour;
   a request over the limit gets a "Review limit reached" reply, so ask again after the time it
   names.
3. Fix each finding with a new commit, or answer it in the thread when it doesn't apply. Then
   comment `@coderabbitai review` again; the new pass covers only the commits pushed since the
   last one.
4. Deploy the branch to staging and check it, then squash-merge. Production deploys from `main`;
   the one exception is a `hotfix/*` branch deployed with `hotfix=true` (docs/LIVE_FIX.md).

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
