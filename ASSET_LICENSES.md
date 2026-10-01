# Asset licenses

Every image in `public/assets/` is listed below with its source, author and license. All 15 launch
characters are by **Kenney Vleugels (Kenney.nl)** and licensed **Creative Commons Zero 1.0 Universal
(CC0-1.0)**: https://creativecommons.org/publicdomain/zero/1.0/

Attribution is optional under CC0; this project credits Kenney as a courtesy. The assets may be used
in personal and commercial projects, redistributed and modified. The software license (`LICENSE`,
MIT) is separate from these asset licenses.

The artwork pixels are unchanged. Only the atlas layout changed: each pose was copied into a
single-row atlas, bottom-centre aligned in a fixed cell, so the frame rectangles in
`public/assets/characters.json` line up.

## Platformer Characters 1 (5 characters, from v1)

- Source: https://kenney.nl/assets/platformer-characters
- Archive: https://kenney.nl/media/pages/assets/platformer-characters/b85f388c42-1677693768/kenney_platformer-characters.zip
- Included notice, byte-for-byte: `public/assets/KENNEY_LICENSE.txt`

| Catalog id | Label | File | Original name | Cell | Frames (in order) | Combat |
|---|---|---|---|---|---|---|
| `adventurer` | Adventurer | `adventurer.png` | Adventurer | 80 x 110 | walk1, walk2, idle, jump, cheer1, cheer2 | effects |
| `female` | Explorer | `female.png` | Female | 80 x 110 | same | effects |
| `player` | Player | `player.png` | Player | 80 x 110 | same | effects |
| `soldier` | Soldier | `soldier.png` | Soldier | 80 x 110 | same | effects |
| `zombie` | Zombie | `zombie.png` | Zombie | 80 x 110 | same | effects |

## Toon Characters 1 (6 characters, added in v2)

- Source: https://kenney.nl/assets/toon-characters
- Archive (downloaded 2026-10-01): https://kenney.nl/media/pages/assets/toon-characters/4e8a6e4e53-1774770819/kenney_toon-characters.zip
- Included notice, byte-for-byte: `public/assets/KENNEY_TOON_LICENSE.txt` ("Toon Characters ... License: (Creative Commons Zero, CC0)")
- Poses taken from `<Character>/PNG/Poses/character_<name>_<pose>.png` (96 x 128 each).

| Catalog id | Label | File | Original character | Cell | Frames (in order) | Combat |
|---|---|---|---|---|---|---|
| `toon-citizen` | Citizen | `toon-citizen.png` | Male person | 96 x 128 | walk0-walk7, idle, jump, cheer0, cheer1, attack0-attack2, hit, down | attack + ko frames |
| `toon-traveler` | Traveler | `toon-traveler.png` | Female person | 96 x 128 | same | attack + ko frames |
| `toon-ranger` | Ranger | `toon-ranger.png` | Male adventurer | 96 x 128 | same | attack + ko frames |
| `toon-scout` | Scout | `toon-scout.png` | Female adventurer | 96 x 128 | same | attack + ko frames |
| `toon-robot` | Robot | `toon-robot.png` | Robot | 96 x 128 | same | attack + ko frames |
| `toon-ghoul` | Ghoul | `toon-ghoul.png` | Zombie | 96 x 128 | same | attack + ko frames |

`ko` uses the `hit` and `down` poses; `attack` uses `attack0` to `attack2`.

## Platformer Art Complete Pack / Platformer Art Deluxe (4 characters, added in v2)

- Source: https://kenney.nl/assets/platformer-art-deluxe
- Archive (downloaded 2026-10-01): https://kenney.nl/media/pages/assets/platformer-art-deluxe/cb30f83169-1677696393/kenney_platformer-art-deluxe.zip
- Included notice, byte-for-byte: `public/assets/KENNEY_PLATFORMER_ART_LICENSE.txt` ("Platformer Art Complete Pack by Kenney Vleugels ... License (CC0)")
- Poses taken from `Extra animations and enemies/Alien sprites/alien<Colour>_<pose>.png` (66-70 x 92-96 each).

| Catalog id | Label | File | Original character | Cell | Frames (in order) | Combat |
|---|---|---|---|---|---|---|
| `alien-beige` | Beige Alien | `alien-beige.png` | alienBeige | 72 x 96 | walk1, walk2, stand, jump, hurt | effects for attack; `ko` = hurt |
| `alien-blue` | Blue Alien | `alien-blue.png` | alienBlue | 72 x 96 | same | effects for attack; `ko` = hurt |
| `alien-green` | Green Alien | `alien-green.png` | alienGreen | 72 x 96 | same | effects for attack; `ko` = hurt |
| `alien-pink` | Pink Alien | `alien-pink.png` | alienPink | 72 x 96 | same | effects for attack; `ko` = hurt |

## Combat fallback flag

Entries without an `attack` animation carry `"combatFallback": "effects"` in `characters.json`.
The overlay plays flash, shake and fade effects over `idle` for them (CONTRACTS.md section 5).

## Custom uploads

Characters uploaded by the broadcaster or moderators through `/admin` are stored in the channel's
Durable Object, not in this repository. The uploader is responsible for having the rights to the
image. Their catalog entries carry `"license": "Uploaded by channel staff"`.

## Reserve

More vetted free characters, ready to import later, are listed in `docs/CHARACTER_RESERVE.md`.
They are not bundled and need a row here when they are added.
