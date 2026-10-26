# Test-site devtools

`scripts/devtools.ts` drives the **test site** (staging.pixfray.xyz) from a terminal: bot fighters,
scripted duels, and an alt account that types in real Twitch chat. Production has none of this.

## How it is locked down

- `DEV_TOOLS_TOKEN` is a Worker secret declared only by `cf deploy --mode test`
  (`cloudflare.config.ts`). The production Worker has no such binding, so no token can match there.
  `tests/worker.test.ts` checks both configs and the token gates below; `tests/dev-api.test.ts` covers `/api/dev/*`.
- A request with `Authorization: Bearer <token>` acts as the owner for `/api/dev/*` and
  `/api/admin/*`, and is the only way into `/api/devtools/<channel>/(profile|chat|live|shop|style|export)`. A wrong or short
  token gets 401; an owner session without the token gets 404 from `/api/devtools`.
- The token can't change production: promote, hotfix and rollback to production return 403
  `owner_session_required`; only the owner signed in with Twitch can run them. It also can't save build
  files (`package.json`, `package-lock.json`, `bun.lock`, `bunfig.toml`, `.npmrc`, `site.config.js`,
  `site.config.ts`, `cloudflare.config.ts`, `vite.config.{js,mjs,cjs,ts,mts,cts}`,
  `postcss.config.{js,mjs,cjs,ts,mts,cts}`, `.postcssrc`, `.postcssrc.{json,yaml,yml,js,cjs,mjs,ts,cts,mts}`,
  `wrangler.{json,jsonc,toml}`, `tsconfig.json`, `tsconfig.<name>.json`, `types/`, `scripts/`): `code/save`
  returns 403 `build_file`, reading them still works.
- The token lives in `~/.pixfray/secrets.test.json` (outside the repo) next to the Twitch app credentials, so the
  normal test deploy uploads it:
  `bunx cf deploy --mode test --secrets-file ~/.pixfray/secrets.test.json`. `cf deploy` uploads every key in the secrets file, so the production file
  (`~/.pixfray/secrets.json`) must not hold it.
- Chat posts go out only after Twitch confirms the channel is offline. If that check fails, nothing is
  sent.

## Bots

Bots are profiles with ids `testbot:a` … `testbot:d` (logins `testbot_a` …). They can't collide with
real Twitch ids, which are numeric.

```bash
node scripts/devtools.ts seed --bots 2
node scripts/devtools.ts duel a b
node scripts/devtools.ts duel a b --via se
node scripts/devtools.ts state
node scripts/devtools.ts live on
node scripts/devtools.ts say a "!checkin" --via se
node scripts/devtools.ts say a "!wallet"
node scripts/devtools.ts say a "!pay @testbot_b 10" --via se
node scripts/devtools.ts gift a 300
node scripts/devtools.ts style a 200
node scripts/devtools.ts buy a pet fox
node scripts/devtools.ts equip a fox
node scripts/devtools.ts say a "!pet" --via se
node scripts/devtools.ts clean
```

- `--via chat` (default) feeds the line through the room the way a Twitch chat message arrives.
- `--via se` calls the public StreamElements route with the channel's key, exactly like the
  StreamElements bot does.
- Both print the reply the StreamElements bot would post.
- `clean` removes the bots from the arena and deletes their profiles and ranks.
- `live on` makes `!checkin` see a live stream with a new stream id, so each `live on` is the next
  stream for streaks (`--stream <id>` reuses one). `!pay` needs it too. `live off` answers "not live", and `live real`
  goes back to asking Twitch. Only the test Worker reads this, because only it has the token.
- `buy <bot> <pet|hat|recolor|petcolor|accessory|trail|effect|taunt|title> <id>` (or `buy <bot> slot`)
  spends the bot's dollars like the viewer page's Buy button (`gift` them first, or `style` for anything but a pet).
  `style <bot> <amount>` adds style dollars the way a channel point reward does. `equip <bot> <pet|none|->`
  brings a pet the bot owns (`-` keeps the current one) and takes `field=id` pairs for cosmetics it owns
  (`recolor`, `petColor`, `accessory`, `trail`, `winEffect`, `taunt`, `title`, `build`). It keeps the
  character, color and hat.

## Alt account in real chat

Use a second Twitch account, never the main one. It signs in once with a device code (scope
`user:write:chat` only), using the test Twitch app. Tokens are saved in `~/.pixfray/devtools.json`
(outside the repo) and refreshed automatically.

```bash
node scripts/devtools.ts login
node scripts/devtools.ts alt-profile
node scripts/devtools.ts real-duel --bot a
```

- `login`: open the printed twitch.tv/activate link signed in as the alt, then enter the code.
- `alt-profile`: gives the alt a saved fighter on the test site.
- `real-duel`: the alt types `!challenge @testbot_a` in chat. The script waits for StreamElements to
  deliver it to the test site, then testbot_a answers `!fight` through the StreamElements route.

This needs the channel's StreamElements commands to point at the test site. If the challenge doesn't
arrive within 20 seconds, the script stops and says so.

`chat <message>` sends any single line as the alt.

## OBS

`work/obs-devtools-run.mjs` (local, outside the repo) refreshes the test-site browser source, runs a
bot duel and saves OBS frames. It refuses to start while OBS is streaming or recording.
