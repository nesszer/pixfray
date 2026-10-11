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
(`.github/workflows/ci.yml`) runs it on pull requests to `main` and on pushes to `main`, `live-fix/`,
`hotfix/` and `port/` branches, next to `bun run test:port`, a gitleaks scan of the whole history and
`bun run audit`. The deploy workflow runs it before uploading a version.

- `bun run format` formats the code with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`,
  120 columns); `bun run format:check` only reports. HTML, Markdown and `public/assets` are left alone.
- `bun run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with type-aware rules
  (`.oxlintrc.json`). Warnings fail it. In `server/` every promise must be awaited or handed to
  `waitUntil`, because the Worker can cancel one that is dropped.
- `bun run typecheck` runs `tsc` on five strict programs (below), then `node scripts/port-check.ts --strict-list`.
  `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` for all of
  them, so every TypeScript file is checked the same way: the Worker, the pages, the unit tests, browser tests,
  scripts and build configs. The one JavaScript file in a program is `site.config.js`, which has tsc check it
  through its own `// @ts-check`.
- `bun run audit` checks every installed package against the advisory database and fails on a high or
  critical one. When the fix sits behind a dependency that pins the old version, add an exact version to
  `overrides` in `package.json` (as for `sharp`) once that release is 7 days old. Before bumping a package,
  `bun pm diff <pkg>@<old> <pkg>@<new>` shows what its code changed.
- The one whole-repo format commit is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## TypeScript port

The code moved from JSDoc-typed JavaScript to strict TypeScript one file at a time. Every file outside
`public/`, except `site.config.js`, is now `.ts`. Node 22.18+ runs `.ts` scripts with no flags, and Vite
and `cf build` strip the types from the pages and the Worker.

- New and ported files are `.ts`, import local files with the `.ts` extension and use only syntax
  that strips to JavaScript (no `enum`, `namespace` or parameter properties; `erasableSyntaxOnly`).
  Type-only imports say `import type` (`verbatimModuleSyntax`).
- Every TypeScript file (`.ts`, `.mts`, `.cts`, `.tsx`) is in one of five strict programs, split by
  runtime so each sees only its own globals. The Worker types, the DOM and Node clash (the Worker types declare
  `Buffer` as `any`; they and the DOM type streams, Web Crypto and canvas contexts differently), so one program
  can't hold them all:
  - `tsconfig.worker.json`: the Worker, every file in `server/`. Workers types only, so server code can't
    use Node, `document` or `window`, and Web Crypto and streams keep the Workers types.
  - `tsconfig.web.json`: browser code, every file in `src/` (the served modules in `src/served/` included),
    and `types/dom.ts`. DOM types and `vite/client`, no Worker or Node types. A browser file that imports a
    server module pulls it into this program too, so such a module (today `server/upgrades.ts`, and through
    type imports in `src/dashboard.ts` and `src/parse.ts`, `server/cosmetics.ts` and `server/model.ts`)
    must type-check with DOM types as well.
  - `tsconfig.node.json`: the scripts that use no DOM or Buffer methods (`scripts/`), `vite.config.ts` and
    `cloudflare.config.ts`, the Node-only test runners (`tests/chrome.ts`, `tests/seed-local.ts`,
    `tests/build-versions.ts`, `tests/upload-workerd.ts`), and the unit tests that import only Worker and
    shared modules (with their helpers: `tests/fakes.ts`, `tests/register.ts` and the others). Worker and
    Node types, no DOM.
  - `tsconfig.node-dom.json`: unit tests that import a DOM module but no Worker module
    (`tests/browser-parse.test.ts`, `tests/overlay.test.ts`, `tests/served.test.ts`), and Playwright code that imports none
    (`tests/dev-ui.ts`, `scripts/og-image.ts`, `scripts/live-chat-e2e.ts`), whose page callbacks
    run in the browser. DOM and Node types. The character build (`scripts/build-characters.ts`,
    `scripts/lib/png-io.ts`, `scripts/lib/zip-read.ts`) is here too: the Worker types declare `Buffer`
    as `any`, which hides its methods in `tsconfig.node.json`.
  - `tsconfig.node-all.json`: unit tests that import both a Worker module and a DOM
    module (`tests/arena-client.test.ts`, `tests/atlas.test.ts`, `tests/cosmetics.test.ts`,
    `tests/spritify.test.ts`), and the browser tests that import a Worker module (`tests/smoke.ts`,
    `tests/ui.ts`, `tests/arena-browser.ts`, `tests/e2e-local.ts`). Worker, DOM and Node types. Keep a test file on one side where
    you can: a Worker test and a DOM test in one file land here, where neither side's globals are
    kept out.

  Test doubles live in `tests/fakes.ts`: `fakeCtx()` (a Durable Object context on real SQLite
  through `node:sqlite`), `asEnv()` and `asExecutionContext()` for partial bindings, `must()` for a
  value the test expects to find, and `Loose` (`any`) for JSON bodies and rows a test asserts on.
  Each of their casts carries its reason there once.

  `tsconfig.worker.json` and `tsconfig.web.json` take a folder (`include`), so a new file in `server/`
  or `src/` is checked as soon as it exists; the three Node programs list each file in `files`. `types/lib-guards.ts`, `types/site.ts` and
  `site.config.js` are in every program. A `.d.ts` file in any fails (below), so new types go in `.ts`
  files. `bun run typecheck` (so `bun run check`) enforces
  this by ending with `node scripts/port-check.ts --strict-list`, which reads every tracked and
  untracked file that git doesn't ignore and prints
  `tsconfig.worker.json, tsconfig.web.json, tsconfig.node.json, tsconfig.node-dom.json and tsconfig.node-all.json cover every TypeScript file`,
  or one line per file it misses, as
  `<file> is not in tsconfig.worker.json, tsconfig.web.json, tsconfig.node.json, tsconfig.node-dom.json or tsconfig.node-all.json`.
  The lines name `tsconfig.worker.json` and each of the other four the repo has (two read
  `a and b` / `a or b`), so a repo with only `tsconfig.worker.json` names it alone. It asks tsc for
  each program (`tsc -p <config> --listFilesOnly`), so `files`, `include` and `exclude` count as
  tsc reads them, and each error tsc prints reading a config fails it too, as
  `tsc -p <config>: error TS…`.
- The strict list also fails when any strict config checks less, as tsc reads it after
  `extends` (`tsc --showConfig`; the rules take about 0.25 s). Each line names the config; the
  problems print in the order `tsconfig.worker.json`, `tsconfig.web.json`, `tsconfig.node.json`,
  `tsconfig.node-dom.json`, `tsconfig.node-all.json`:
  - `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and
    `erasableSyntaxOnly` must be true:
    `<config> must set <option> to true (it is <value or "not set">)`.
  - `noCheck`, `noLib`, `noResolve` and `noStrictGenericChecks` turn checks off, so true fails. Every
    other `strict*` or `no*` option, `alwaysStrict` and `useUnknownInCatchVariables` fail at false:
    `<config> sets <option> to <value>, which checks less`.
  - Every program keeps `skipLibCheck`, because `@types/node` and `@cloudflare/workers-types`
    declare the same globals, and `skipLibCheck` skips every declaration file. So a `.d.ts` file in
    a strict program fails with
    `<file> is a declaration file, which skipLibCheck leaves unchecked in <config>; name it .ts`.
    That is why `types/lib-guards.ts` is a `.ts` file.
- `bun run lint` fails `// @ts-nocheck` and a `@ts-ignore` or `@ts-expect-error` with no reason
  after it (`typescript/ban-ts-comment`), so a TypeScript file is checked whole. oxlint reads that
  rule in TypeScript files only, and a lint directive comment can turn it off (oxlint has no option
  to ignore them), so the strict list also reads the comments of every code file in the strict
  programs, JavaScript ones included; text in strings is not read. A file in several programs is
  read once and named with the first of them in that order. A `@ts-nocheck` in any letter case
  (`/// @ts-nocheck`, `// @TS-NOCHECK`) fails as
  `<file>:<line> has <pragma>, which turns type checking off; files on <config> are checked whole`,
  and any `eslint-disable` or `oxlint-disable` comment (line, next-line or block; naming rules or
  blanket) as
  `<file>:<line> has <directive>, which can turn off any lint rule, ban-ts-comment included; files on <config> take no lint directives`.
- Each `any`, `as` cast or `!` assertion says why in a comment on that line or the line above.
- `types/lib-guards.ts` lets `Number.isInteger` narrow `unknown` to `number`, so a port needs no
  added `typeof` check, which would change the runtime code. The guard names a branded number, so
  the false branch of `number | undefined` stays `number | undefined`. Inside
  `if (Number.isInteger(u))`, `let c = u` infers the branded type, so `c = c + 1` fails; write
  `let c: number = u`.

A port pull request changes types only, from a `port/<name>` branch:

1. `node scripts/port-rename.ts server/<name>.js` renames the file to `.ts`, points its importers of
   every code extension (`.d.ts` included) at the `.ts` path, keeping any `?query` or `#hash`, and
   updates the repo path in docs, configs and comments. It lists the code strings that still name
   the old path; they are runtime values, so decide on them in their own change. It refuses files
   under `public/`, which Vite serves as written, so they stay JavaScript, and it never rewrites a
   file there: each line under `public/` that names a renamed file prints as
   `note: <file>:<line> names a renamed file; left as is, since public/ is served as written`.
   Any byte changed there changes what browsers load, so update those lines in a change of their own.
   The overlay modules in `src/served/` port like any other file: the build serves each as the
   oxc-stripped JavaScript of its `.js` or `.ts` source at `/<name>.js` (docs/CONTRACTS.md §9). oxc
   keeps comments, so a port that adds only types serves the same code under the same `?v=` hash,
   while a changed comment changes the hash and open overlays reload once.
2. Add types until `bun run typecheck` passes. A file in `server/` or `src/` is already in its program;
   add any other to `files` in `tsconfig.node.json` (scripts, unit tests of Worker modules),
   `tsconfig.node-dom.json` (unit tests of DOM modules, Playwright code) or `tsconfig.node-all.json`
   (tests that import both).
3. `bun run port-check` (`node scripts/port-check.ts --base origin/main`) checks every file that
   differs between the working tree and where the branch left `main`. Code files are `.js`, `.mjs`,
   `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx`. Run without `--base <ref>` or `--strict-list`,
   it prints the usage line and exits 2.
   - Pairing. A file pairs with the same path. A code file gone at head pairs with a new code file
     of the same name, the base name without its code extension: first in the same folder
     (`server/a.js` and `server/a.ts`), then anywhere in the repo (`src/overlay.js` and
     `src/served/overlay.ts`). git's rename detection is not used. When more than one gone or new
     file shares a name, the check fails and names them instead of guessing; move or rename such
     files in separate steps. A port keeps each file's name.
   - A gone file with no pair fails. A new code file with no pair passes only when it strips to no
     runtime code (types only, such as `server/env.ts`). A new file of any other kind that ships
     fails as `<path> is new and ships`.
   - Comparing code. Both versions are stripped to JavaScript with oxc, with comments removed
     except bundler annotations that start the comment, which stay: `#__NAME__` and `@__NAME__`
     (`/*#__PURE__*/`, `/* @__NO_SIDE_EFFECTS__ */`), `@vite-ignore`, `webpack...:`
     (`webpackChunkName:`) and `turbopackIgnore:`. A hashbang (`#!/usr/bin/env node`) is removed
     like a comment in both, since oxc reports it as one only in JavaScript. A relative import path at head is read as the
     path the base file would write to reach the base version of the same target, so a moved
     importer or a renamed target is not a difference, while `./b.mjs` changed to `./b.js` is.
   - Strings in code that doesn't ship. In `tests/`, `scripts/`, `cloudflare.config.ts` and
     `vite.config.ts`, a string literal naming a moved code file is read the same way, so a test
     that reads `"src/ui.ts"` or the Worker `entrypoint: "./server/worker.ts"` passes once it names
     the new path. The base file's strings are read the same way, so a string that already named
     the new path before the port passes whether it is kept or not. Any other change in those
     files still fails, and so does a string naming the
     new path in code that ships.
   - `public/` is served as written, so it keeps its paths and its bytes. A code file under
     `public/` that is renamed or moved in or out fails as
     `<base> -> <head> changes a path under public/, which serves code as written`, and a `.ts`,
     `.mts`, `.cts` or `.tsx` file there fails as
     `<path> is TypeScript under public/, which serves code as written`. Every changed file there
     compares byte for byte, comments and renamed paths included, as
     `<path> differs (line N; public/ is served as written)`, `(binary; ...)` when either side
     holds a NUL byte, or `(in bytes that decode the same; ...)`; a new file there fails as
     `<path> is new and ships`.
   - A `tsconfig*.json` outside `public/` prints
     `allowed: <path> (the build diff compares what the build makes with it)` and is not counted:
     the build diff below sees what it changes, and the strict options are compared on their own.
     For each strict config the merge base has (any of the four),
     the head's `compilerOptions` for it, as tsc resolves them after `extends`
     (`tsc -p <config> --showConfig`, run in the working tree and in the base checkout at
     `.port-check/<sha>/`, which is made for this even without a build config), must equal the
     base's, so a port changes only the `files` lists. That covers `paths`, `types`, `lib`,
     `typeRoots` and every other option, not only the ones the strict list reads. Each option that
     differs fails as
     `<config> changes <option> from the base (base <JSON or "not set">, head <JSON or "not set">); a port changes only its files list`,
     and a strict config the base has but the head lacks as
     `<config> is gone at head; the base has it, so a port keeps it`. A base without a strict config
     (the change that adds it) skips this for that config; the strict-list rules above still apply. Without `cloudflare.config.ts` nothing builds, and
     the reason reads `no build config reads it`. One case fails, and counts as compared and
     different: a `tsconfig.json` new at the repo root, because the base build runs inside the
     repo and would read it too. It prints `tsconfig.json is new at the repo root, where the base
     build would read it too, so the build diff cannot see what it changes; add it in a change of
     its own` (one line).
   - Other files fail closed, with two exceptions. Files that don't ship print
     `allowed: <path> (<reason>, does not ship)` and are not counted: Markdown outside `public/`
     (documentation) and `.coderabbit.yaml` (review config).
     A shipped text file outside `public/` (`package.json`, HTML) passes, as
     `allowed: <path> (only renamed paths changed)`, when its diff disappears once every code path
     on a head line that names a moved file is read as the base path: `./` and `../` paths from
     the file's folder, and `/` and other paths from the repo root. A `?query` or `#hash` after
     the path is kept as it is. Both sides must be valid UTF-8, since invalid bytes all decode to
     the same character and equal text would hide them. Any other change fails at its first
     differing line, as `<path> differs (line N)` with both lines; a file with a NUL byte prints
     `<path> differs (binary)`, and one whose bytes changed but decode to the same text prints
     `<path> differs (in bytes that decode the same)`. A byte order mark added or dropped is a
     change on line 1.
   - Imports at head. Every relative static import, re-export and literal dynamic `import()`
     (a quoted string or a template with no `${}`) in every code file at head, changed or not,
     must name a file at head, or the check prints
     `<file> line N imports <path>, which does not exist at head`. That catches an importer left
     on `./ranklog.js` after the rename. A re-export of inline types only
     (`export { type A } from "./a.ts"`) fails as well: oxc strips it to `export {} from`, which
     Node still loads, so write `export type { A } from`. The import form, `import { type A } from`,
     fails `bun run lint` (`typescript/no-import-type-side-effects`).
   - The build diff is the ground truth. When `cloudflare.config.ts` is at base or head, the merge
     base is checked out to `.port-check/<sha>/` and both it and the working tree are built with
     `bunx cf build`, offline, at the same time. Every file under `.cloudflare/output/` must match:
     JavaScript with its comments removed (the Worker bundle keeps `//#region <path>` and JSDoc,
     which name old paths) and every other file byte for byte. A client chunk whose content hash
     changed pairs with the one file of the same name on the other side, and is labelled
     `.cloudflare/output/<base file> -> <head name>`. A difference prints as
     `.cloudflare/output/<file> differs (line N)` with both lines (`(base line X, head line Y)`
     when the line numbers differ, `end of file` past the last line, `(binary)` for a file with a
     NUL byte, `(in bytes that decode the same)` for one that is not valid UTF-8 and reads the same
     as text), or as `.cloudflare/output/<file> is only in the base build` (or `head build`).
   - A failed build prints `the head build failed (bunx cf build):`, or
     `the base build failed (bunx cf build in .port-check/<sha>):`, then one indented block. For
     a non-zero exit, that is up to the last 12 lines of its output, without colors, stack frames,
     blank lines or bare braces. A non-zero exit fails even when the output markers are fresh. For
     an exit 0 that left an output marker missing or older than the run, it is one line naming only
     those markers:
     `  exited 0 without writing .cloudflare/output/v0/config.json, .cloudflare/output/v0/workers/default/worker.config.json`.
     When `bunx` cannot start, it is the error message. Both builds run with
     `npm_config_offline=true` and `NPM_CONFIG_REGISTRY` and `BUN_CONFIG_REGISTRY` set to
     `http://127.0.0.1:9`, so a missing package fails instead of downloading. Builds that cannot
     be set up at all print `the builds could not start: <error>`.
     The base checkout has no `node_modules` of its own, so its build loads the repo's from above
     `.port-check/`, which is sound because a change to `package.json` or `bun.lock` already fails
     the file checks. Anything else in `.port-check/` would load first (bunx runs the nearest
     `node_modules/.bin/cf`, and Node and Vite read the nearest `node_modules` and config files),
     so any entry there other than a `<sha>` or `<sha>.partial` folder stops both builds with
     `the builds could not start: .port-check holds <names>, which the base build would load from above its checkout; only base checkouts (<sha> folders) belong there, so move the rest out and rerun`
     (up to three names, then `and N more`).
   - A link (a symlink, or a junction on Windows) at `.port-check`, at a `.port-check/<sha>`
     folder, or at or inside `.cloudflare/` or `.wrangler/` in the base checkout or the working
     tree stops both builds before anything is written. The checkout and the build would write
     through it to wherever it points:
     `the builds could not start: <path> is a link (a symlink or junction), which port-check and the build would write through to wherever it points; make it a plain folder or move it out, and rerun`.
     On Linux and macOS, git sees a symlink named `.cloudflare` or `.wrangler` as a file that
     the folder rules in `.gitignore` don't match, so it is also listed as `is new and ships`.
   - `.port-check/` is git-ignored and grows by one folder per merge base (about 17 MB for this
     repo, built output included), with git's scratch index for the checkout inside it;
     port-check reuses a folder and never deletes one. Recycle old folders by hand. Before either
     build runs, it reads the base tree back into that index and hashes the folder (about 0.3 s):
     a file changed, missing or extra, outside the build's own `.cloudflare/` and `.wrangler/`,
     stops both builds with
     `the builds could not start: .port-check/<sha> does not hold the base commit (changed or missing: <paths>; not in the base: <paths>); move that folder out of the repo and rerun`
     (up to three paths each, then `and N more`). It refuses instead of rebuilding, because
     rebuilding would mean deleting the extra files. A path git tracks at `.port-check` in any
     letter case (a file, a folder or a symlink; on Windows `.Port-Check/<sha>/x` lands inside the
     checkout) skips both builds and prints
     `.port-check (in any letter case) is where port-check checks out the base, and git tracks N paths there that no check compares (<first path> and N-1 more); take them out of git`.
     Only ASCII letters fold: a `k` written as the Kelvin sign (U+212A) makes an ordinary folder,
     which is compared like any other.
   - It prints the first differing line of each file with its source line at base and at head
     (`head has no runtime code` when the head strips to nothing), then
     `N files compared, M different`, then `; B build output files compared, D different` when it
     built (`; the build failed` when a build failed, `; the builds did not run` when a committed
     or mismatched `.port-check`, a stray entry in it or a link stopped them). N counts every changed, moved and new file
     it compared: gone, ambiguous, don't-ship and allowed `tsconfig*.json` files and code moved in
     or out of `public/` are not counted. `, K other problems` follows for unpaired and ambiguous
     files, `public/` paths and TypeScript, a committed or mismatched `.port-check`, import and
     strict-list failures, and builds that failed or could not start. It exits 1 on any difference or problem. A branch
     that adds runtime code, such as a new script, fails it by design: that belongs in a `ts/`
     branch.

   CI runs it on every push to a `port/` branch and every pull request from one to `main`. Its
   own tests are `bun run test:port` (`tests/port/port-check.test.ts`), kept out of
   `bun run check` because they build small fixture repos in the OS temp folder (40-70 s on a
   32-thread machine with the six-build cap below, about 80 s on CI). Each run keeps its fixtures in
   one new `pixfray-port-check-*` folder there (about 15 MB of files, 20 MiB on disk, measured at
   95 tests), so the temp folder gains one entry per run. Each run folder holds five junctions (on
   Linux and macOS, symlinks) from the link tests, each pointing at an empty folder next to its repo
   in the same run folder, so nothing they point at lies outside it. Nothing is deleted by script (AGENTS.md), and reusing a fixed folder would mean emptying
   it first, so recycle old run folders by hand.
   CI runs them next to `bun run check`, on pull requests to `main` and pushes to `main`,
   `live-fix/`, `hotfix/` and `port/` branches; run them after changing
   `scripts/port-check.ts`, `scripts/port-rename.ts` or `scripts/lib/port.ts`. Each build
   fixture gets its own `node_modules/.bin` shims that run this repo's cf and Vite by absolute
   path, and the tests drop every `node_modules/.bin` from `PATH` (`bun run` adds the repo's), so
   nothing else can stand in for them. They set `NODE_DISABLE_COMPILE_CACHE=1`, so Vite leaves no
   compile cache in the temp folder. At most six fixtures build at once (two Vite builds each):
   all sixteen together took the 16 GB CI runner down.

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
- `bun run test:port` (port-check's and port-rename's own tests),
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
