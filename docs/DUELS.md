# How duels work

Everything a viewer or mod needs to know about a duel, from the challenge to the payout.

## Starting a duel

- `!challenge @viewer` challenges someone. They answer `!fight` or `!decline`.
- `!rematch` challenges the last viewer you fought.
- `!fray` explains how to join, and `!look` links to your fighter on the site.

## How a duel is rolled

The duel is rolled at once, the moment the challenge is accepted.

- Fighters take turns, challenger first. Both start at 100 HP.
- Each swing is a d6:

  | Roll | Result |
  |---|---|
  | 6 | Crit for 50 |
  | 5 | Hit for 34 |
  | 3-4 | Miss |
  | 1-2 | The defender counters for 34 |

- After 12 rolls, the fighter with more HP wins. Equal HP goes to sudden death.
- A winner who took no damage gets +3 Elo.

## What chat sees

- The bot only says "Fight on: A vs B! Watch the stream for the winner."
- The overlay replays the duel in about 8-25 s, then shows the Elo change.
- On a channel with the PixFray chat bot, the bot then announces the winner in chat.
- `!elo`, `!ranks` and the website hold back the new numbers until the replay has played (plus the
  channel's stream delay), so chat doesn't spoil the stream.

## Upgrades, hats and check-ins

- Each win earns an upgrade point and unlocks hats. Points have no cap. Points buy levels in seven stats:

  | Stat | Each level (levels 1-8) | Ceiling |
  |---|---|---|
  | Power | +4% damage dealt | 60% |
  | Guard | -4% damage taken | 60% |
  | Luck | 4% of your misses still hit | 50% |
  | Crit | 4% of your hits become crits (HP fights: a strike or heavy deals +50%) | 50% |
  | Dodge | 4% of hits and crits on you miss | 50% |
  | Counter | +2% counter damage, and 2% of a foe's misses become your counter | 60% damage, 50% chance |
  | Vitality | +4 max HP | +60 HP |

- Luck, dodge and counter work in quick duels only. Vitality works in both: you start with more HP, heal up to it, and a flawless win needs all of it. A swing checks luck, then crit, then dodge, then
  counter, so a dodged hit can still turn into your counter.
- Levels 1-8 of a stat cost 1 point each; the cost doubles every 8 levels after that, and each level
  adds less as the stat nears its ceiling. Mods set the highest level that counts on their channel
  (16 by default); levels above it stay saved.
- `!checkin`, once per live stream, adds a point too, with streak bonuses: +1 at 3, 7, 14 and 30
  streams, +2 at 60, +3 at 100, +5 at 200 and +10 at 365.
- `!pet` shows a fighter's pet. `!stats` (or `!stats @name`) shows the upgrade levels that count, unspent points and the pet's boost.
- A legendary pet gives +1 to 4 different stats, rolled at random when you buy it. You can reroll them
  once for free on the Fighter tab; the new set is always different. Not during a challenge or duel.

## PixFray dollars

- Ranked duels pay saved fighters: $5 a win, $3 a loss. Past a pair limit (if mods set one, below), a
  duel pays half ($2 and $1). Other unrated duels pay nothing.
- `!wallet` shows your dollars.
- `!pay @name 10` passes them on (`!give` on channels with the PixFray chat bot). You can pay after
  5 finished duels, at most $100 per stream, and only while the stream is live.
- On a channel that has PixFray channel point rewards, redeeming one adds its dollars to your saved fighter and
  the bot says your new wallet. Without a saved fighter the redemption is refunded and the bot links the fighter page.
- Dollars show only to mods and the owner on the website.

## Ranked and unrated duels

- Duels count only while the stream is live. Offline duels are unrated and pay nothing. If Twitch
  can't say whether the stream is live, the last answer stands.
- Live duels are always ranked, with no limit per pair. Mods can set a limit per pair each stream in
  the balance editor (0 means no limit). With one, the last ranked result says "Last ranked duel
  between them this stream." After that the pair still fights, unrated, for half the dollars, and
  they're ranked again next stream.
- With a limit set, `!stats @name` adds how many ranked duels you have left against that fighter this
  stream.
- A Twitch account under 7 days old also duels unrated. If Twitch can't say how old an account is,
  the duel is ranked.
- An unrated duel moves no Elo, wins or losses. The reply starts "Just for fun" and says why.

## What mods and the broadcaster control

- Mods tune every number in the balance editor on the mod controls page. Every change is versioned
  and can be undone.
- Mods reset one pair's ranked duels for this stream with `!resetpair @name @name` in chat or
  "Reset pair count" on the mod page.
- Only the broadcaster (or the site owner) can reset all ranks, make a new StreamElements key, turn
  PixFray off or move chat from another site.
- Turning PixFray off keeps every fighter and rank.

The exact rules and data formats are in [CONTRACTS.md](CONTRACTS.md).
