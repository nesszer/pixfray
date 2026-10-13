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

- Each win earns an upgrade point and unlocks hats. Points have no cap. Points buy levels in six stats:

  | Stat | Each level (levels 1-8) | Ceiling |
  |---|---|---|
  | Power | +4% damage dealt | 60% |
  | Guard | -4% damage taken | 60% |
  | Luck | 4% of your misses still hit | 50% |
  | Crit | 4% of your hits become crits (HP fights: a strike or heavy deals +50%) | 50% |
  | Dodge | 4% of hits and crits on you miss | 50% |
  | Counter | +2% counter damage, and 2% of a foe's misses become your counter | 60% damage, 50% chance |

- Luck, dodge and counter work in quick duels only. A swing checks luck, then crit, then dodge, then
  counter, so a dodged hit can still turn into your counter.
- Levels 1-8 of a stat cost 1 point each; the cost doubles every 8 levels after that, and each level
  adds less as the stat nears its ceiling. Mods set the highest level that counts on their channel
  (16 by default); levels above it stay saved.
- `!checkin`, once per live stream, adds a point too, with streak bonuses: +1 at 3, 7, 14 and 30
  streams, +2 at 60, +3 at 100, +5 at 200 and +10 at 365.
- `!pet` shows a fighter's pet.

## PixFray dollars

- Ranked duels pay saved fighters: $5 a win, $3 a loss.
- `!wallet` shows your dollars.
- `!pay @name 10` passes them on (`!give` on channels with the PixFray chat bot). You can pay after
  5 finished duels, at most $100 per stream, and only while the stream is live.
- Dollars show only to mods and the owner on the website.

## Ranked and unrated duels

- The same two fighters get 5 ranked duels per rolling 24 hours. After that they still fight,
  unrated.
- A Twitch account under 7 days old also duels unrated. If Twitch can't say how old an account is,
  the duel is ranked.
- An unrated duel moves no Elo, wins, losses or dollars, and the reply starts "Just for fun".

## What mods and the broadcaster control

- Mods tune every number in the balance editor on the mod controls page. Every change is versioned
  and can be undone.
- Only the broadcaster (or the site owner) can reset all ranks, make a new StreamElements key, turn
  PixFray off or move chat from another site.
- Turning PixFray off keeps every fighter and rank.

The exact rules and data formats are in [CONTRACTS.md](CONTRACTS.md).
