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

- Each win earns an upgrade point (power, guard, luck) and unlocks hats.
- `!checkin`, once per live stream, adds a point too, with streak bonuses.
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
