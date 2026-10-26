# Development

## Run it locally

Requires [Bun](https://bun.sh) 1.4+ and Node 22.18+. Bun installs the packages and runs the
scripts; the tools themselves (`cf`, Vite, Playwright, the tests) run on Node.

```bash
bun install
```

`bun install` also points git at the hooks in `.githooks/` (`scripts/install-hooks.ts`). Before
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
(`.github/workflows/ci.yml`) runs it on pull requests to `main` and on pushes to `main`, `live-fix/`
and `hotfix/` branches, next to a production build, a gitleaks scan of the whole history and
`bun run audit`. The deploy workflow runs it before uploading a version.

- `bun run format` formats the code with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`,
  120 columns); `bun run format:check` only reports. HTML, Markdown and `public/assets` are left alone.
- `bun run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with type-aware rules
  (`.oxlintrc.json`). Warnings fail it. In `server/` every promise must be awaited or handed to
  `waitUntil`, because the Worker can cancel one that is dropped.
- `bun run typecheck` runs `tsc` on five strict programs, then `node scripts/strict-check.ts` (below).
  `tsconfig.base.json` sets the strict options for all of them. The one JavaScript file in a program
  is `site.config.js`, which has tsc check it through its own `// @ts-check`.
- `bun run audit` checks every installed package against the advisory database and fails on a high or
  critical one. When the fix sits behind a dependency that pins the old version, add an exact version to
  `overrides` in `package.json` (as for `sharp`) once that release is 7 days old. Before bumping a package,
  `bun pm diff <pkg>@<old> <pkg>@<new>` shows what its code changed.
- The one whole-repo format commit is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## TypeScript

Every file outside `public/`, except `site.config.js`, is strict TypeScript. Node 22.18+ runs `.ts`
scripts with no flags, and Vite and `cf build` strip the types from the pages and the Worker.

- Files import local files with the `.ts` extension and use only syntax that strips to JavaScript
  (no `enum`, `namespace` or parameter properties; `erasableSyntaxOnly`). Type-only imports say
  `import type` (`verbatimModuleSyntax`).
- Each `any`, `as` cast or `!` assertion says why in a comment on that line or the line above.
- Every TypeScript file is in one of five strict programs, split by runtime so each sees only its
  own globals. The Worker types, the DOM and Node clash (the Worker types declare `Buffer` as `any`;
  they and the DOM type streams, Web Crypto and canvas contexts differently):
  - `tsconfig.worker.json`: every file in `server/`. Workers types only.
  - `tsconfig.web.json`: every file in `src/` and `types/dom.ts`. DOM types and `vite/client`. A
    server module a page imports (`server/upgrades.ts`, and through type imports `server/cosmetics.ts`
    and `server/model.ts`) must type-check here too.
  - `tsconfig.node.json`: every `.ts` file at the root and in `scripts/` and `tests/` that the two
    programs below don't list (it excludes them), so a new script or test lands here. Workers and
    Node types, no DOM.
  - `tsconfig.node-dom.json`: unit tests of DOM modules, Playwright code whose page callbacks run in
    the browser, and the character build (`scripts/build-characters.ts`, `scripts/lib/png-io.ts`,
    `scripts/lib/zip-read.ts`, which need `Buffer`'s methods). DOM and Node types.
  - `tsconfig.node-all.json`: tests that import both a Worker module and a DOM module. Workers, DOM
    and Node types. Keep a test on one side where you can.

  To move a file to a DOM program, add it to that program's `files` and to the `exclude` list in
  `tsconfig.node.json`. `types/lib-guards.ts`, `types/site.ts` and `site.config.js` are in every
  program.
- `bun run typecheck` ends with `node scripts/strict-check.ts`, which fails when a TypeScript file
  in the working tree (tracked, or new and not ignored) is in none of the five programs, when a
  program turns off `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly` or any other `strict*` or `no*` check (as
  `tsc --showConfig` resolves it), when a program holds a `.d.ts` file (every program keeps
  `skipLibCheck`, which skips them, so new types go in `.ts` files), and when a file in a program
  holds `@ts-nocheck` or an `eslint-disable` or `oxlint-disable` comment. `bun run lint` fails
  `@ts-nocheck` and a `@ts-ignore` or `@ts-expect-error` with no reason (`typescript/ban-ts-comment`);
  the strict check covers the lint directives that could turn that rule off.
- Test doubles live in `tests/fakes.ts`: `fakeCtx()` (a Durable Object context on real SQLite
  through `node:sqlite`), `asEnv()` and `asExecutionContext()` for partial bindings, `must()` for a
  value the test expects to find, and `Loose` (`any`) for JSON bodies and rows a test asserts on.
- `types/lib-guards.ts` lets `Number.isInteger` narrow `unknown` to a branded `number`. Inside
  `if (Number.isInteger(u))`, `let c = u` infers the branded type, so `c = c + 1` fails; write
  `let c: number = u`.

## Pull requests and review

Changes reach `main` through a pull request:

1. Commit on a branch (the hooks run), push it and open a PR against `main` (`gh pr create`).
2. CI runs. [CodeRabbit](https://coderabbit.ai) reviews when a PR comment asks for it
   (`@coderabbitai review`; automatic reviews need 10 stars, and the free plan allows one an hour).
   `.coderabbit.yaml` points it at `AGENTS.md` and `DESIGN.md`.
3. Fix each finding with a new commit, or answer it in the thread when it doesn't apply.
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
