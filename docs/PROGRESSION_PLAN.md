# Plan: check-ins, Mini Chat dollars, pets and builds

Status (2026-10-07): done; this file is the original plan, kept for history. Current prices and rules
are in `server/game.js` (`DEFAULT_CONFIG`) and CONTRACTS.md: shop prices were cut to a third on
2026-10-06, the give command is `!pay` on StreamElements and `!give` on channels with the PixFray bot, and
unrated duels (see Risks) pay nothing.

Agreed with the owner on 2026-10-04. Stage 1 (check-ins, streaks, 20/8 caps) and
Stage 2 (dollars, `!wallet`, `!pay`, mod gifts), Stage 3 (pets, the shop, `!pet`, uploaded pets) and Stage 4 (builds,
cosmetics, the tabbed viewer page) are built; all four have run in production since 2026-10-05. Every number below is a default that
mods can tune in the balance editor (versioned, undoable). All data is per channel, like fighters
and ranks today.

## What viewers get

| System | How it works |
|---|---|
| Check-in | `!checkin` in chat, once per stream, only while the channel is live (the server asks Twitch). Gives 1 upgrade point. |
| Streak | Streams in a row checked in, with 1 free miss per week. Bonus +1 point at 3, 7, 14 and 30. |
| Upgrade points | One pool from wins (1 each) and check-ins. Cap raised from 10 to 20 total and from 5 to 8 per stat. Respec stays free outside a duel. Still power, guard and luck; no new stats. |
| Mini Chat dollars | Win a duel $5, lose $3. Mods can gift dollars from the admin page. Check-ins give points, not dollars. |
| `!pay @name amount` (planned as `!give`; StreamElements' `!givepoints` owns that name) | At most $100 given per stream, only after 5 finished duels, and the streamer can turn it off. |
| Pets | Bought with dollars. Collect many, 1 active. Shown next to the fighter on stream. |
| Builds | 1 build slot free; more cost $200, then $400, up to 5. Each build keeps its own character, recolor, stats, hat, pet, accessory, trail, taunt and title. Every build can spend the full point pool. |
| Rank reset | Resets Elo and wins only. Dollars, pets, cosmetics and check-in points stay. |

## Pets

| Tier | Boost | Default price |
|---|---|---|
| Common | +1 to one stat | $30 |
| Uncommon | +1 to one stat, fancier look | $75 |
| Rare | +2 to one stat | $180 |
| Epic | +2 to one stat and +1 to another | $420 |
| Legendary | +3 split across stats, special look | $900 |

- Rarer pets also look better. A boost can go past the per-stat cap, up to about +12% at the top.
- At launch: 10 or more built-in pets across the 5 tiers and 3 stats.
- Art comes from 3 sources: pixel art drawn in code (like hats), CC0 sprite packs (logged in
  ASSET_LICENSES.md), and streamer uploads. For an upload, the streamer picks the tier, which sets
  the boost and the default price.
- Prices are set so a regular fighter (about 10 duels, roughly $40 per stream) gets a first pet
  within one stream and a Legendary after about 5 to 6 weeks.

## Shop (website only)

- Pets and pet colors.
- Hats: each hat unlocks by wins as today, or can be bought early.
- Win effects (confetti, fireworks, banner) and titles.
- Character recolor, accessories (glasses, capes) and walking trails.
- Win taunts and titles come from a preset list only, so no free text reaches the stream.

## Chat commands (new)

`!checkin`, `!wallet` (dollars, points, streak), `!give @name amount` and `!pet` (active pet and
its boost). On StreamElements channels each one needs its own `!cmd add` line. The admin page lists
the lines, and the checklist marks each command Working once it has been used.

## Website

- **Tabs:** Fighter (character, recolor, stats, builds), Shop, Pets and Ranks.
- **Preview:** a true on-stream preview stays at the top of every tab.
- **Fixes:**
  - character search and filters
  - stats explained in plain numbers ("+8% damage dealt")
  - mobile-first layout, since most viewers come from chat on a phone
- Follows the design rules and is checked with design.py at 1280 and 390 px.

## Stages (each one passes the end-to-end tests below, is deployed and verified live before the next)

1. Check-in, streaks and the raised point caps. Includes the Twitch live check and the `!checkin`
   command.
2. Dollars: duel earnings, mod gifts, `!wallet` and `!give` with its limits.
3. Shop and pets: built-in pets, the overlay pet sprite, `!pet` and streamer pet uploads.
4. Builds, recolor, accessories, trails, win effects, taunts and titles, plus the website redesign
   into tabs.

## End-to-end testing (every stage)

Unit tests and `bun run test:all` come first. Then each stage is checked for real, on the test
site first and on prod after the deploy.

**OBS (local, OBS WebSocket 5 on port 4455)**
- A new scene, "Mini Chat — Progression Test", holds one browser source with the overlay at
  1920×1080. Scene and Scene 2 are never touched.
- Scripts refresh the source, run duels, check-ins and pet changes, and save frames to `work/`.
  Each run is checked against these frames: pet next to the fighter, pet look by tier, recolor,
  trail, win effect, title.
- It refuses to start while OBS is streaming or recording. Nothing is ever streamed or recorded.

**Website (the executor's browser-use, headed Chrome with its own profile)**
- The viewer site is driven like a person would use it: tabs, character search, shop, buying a
  pet, switching builds, stats. It is looked at in the browser and checked at 1280 and 390 px.
- **Twitch sign-in:** when the work needs it, I ask you to sign in with your main and your alt
  account, each in its own Chrome window (main on port 9333, alt on 9334). I never type your
  passwords.

**Real chat (`bun run test:live`, extended)**
- **Both accounts:** they run `!checkin`, `!wallet`, `!give` (including every limit and refusal)
  and `!pet`. Each bot reply must appear in both chat windows and match the website and the OBS
  frame.
- **Commands:** I set up the new StreamElements commands by posting the `!cmd add` lines from your
  main account. I show you the lines first.
- **When it posts:** only while nesszerra is offline. Check-ins need a live channel, so they are
  tested on the test site with a stubbed "live" answer; the real Twitch live check is tried once,
  with you, during a test stream that you start.
- Logs and screenshots go to `work/progression-e2e/`. They are never committed.

## Risks to watch

- **Stronger fighters:** points up to 20 plus a pet makes stacked fighters stronger, up to about
  +44% damage against an unupgraded one. Check win rates after stage 1 and tune it from the
  balance editor.
- **Alt accounts:** `!give` lets alts feed a main account. The 5-duel and $100 limits slow this
  down; they don't stop it. Since 2026-10-07 the same pair gets 5 ranked duels per rolling 24 hours
  (`PAIR_RATED_PER_DAY`) and a Twitch account under 7 days old (`NEW_ACCOUNT_MS`) duels unrated; an unrated
  duel moves no Elo, wins, losses or dollars.
- **Setup work:** each StreamElements channel has to add 4 new commands.
- **Twitch live check:** it uses the app token and is cached for 60 s. If Twitch is down,
  `!checkin` says "try again", rather than awarding or refusing the point.
