# Asset licenses

Every image in `public/assets/` is listed below with its source, author and license. All 15 launch
characters are by **Kenney Vleugels (Kenney.nl)**. The 24 characters added in v3 are by **Kenney** and by
**pzUH** (OpenGameArt). Everything is licensed **Creative Commons Zero 1.0 Universal (CC0-1.0)**:
https://creativecommons.org/publicdomain/zero/1.0/

Attribution is optional under CC0; this project credits Kenney as a courtesy. The assets may be used
in personal and commercial projects, redistributed and modified. The software license (`LICENSE`,
MIT) is separate from these asset licenses.

The artwork of the 15 launch characters is unchanged. Only the atlas layout changed: each pose was copied
into a single-row atlas, bottom-centre aligned in a fixed cell, so the frame rectangles in
`public/assets/characters.json` line up. The 24 v3 characters are built the same way by
`scripts/build-characters.mjs` (`npm run build:characters`), which also resizes where noted below: the pzUH
art is scaled down to about 104 px tall (area average), pixel art is scaled up by a whole number with
nearest-neighbour (no blur), and smooth art is scaled up 2x with bilinear filtering. CC0 permits modification.
The script reads the original archives (listed below with their SHA-256 in the script), so the build is
repeatable.

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

## New Platformer Pack 1.1 (9 characters, added in v3)

- Source: https://kenney.nl/assets/new-platformer-pack
- Archive (downloaded 2026-10-02): https://kenney.nl/media/pages/assets/new-platformer-pack/1896103897-1764756702/kenney_new-platformer-pack-1.1.zip
- Author: Kenney (www.kenney.nl); license CC0-1.0
- Included notice, byte-for-byte: `public/assets/KENNEY_NEW_PLATFORMER_LICENSE.txt` ("New Platformer Pack (1.1) ... License: (Creative Commons Zero, CC0)")
- Astronauts from `Sprites/Characters/Default/character_<colour>_*.png` at native size; animals from `Sprites/Enemies/Default/<name>_*.png`, scaled up 2x (bilinear).

| Catalog id | Label | File | Original character | Cell | Frames (in order) | Combat |
|---|---|---|---|---|---|---|
| `npp-mint` | Mint Astronaut | `npp-mint.png` | character_green | 84 x 101 | walk_a, walk_b, idle, jump, front, hit | effects for attack; `ko` = hit |
| `npp-violet` | Violet Astronaut | `npp-violet.png` | character_purple | 84 x 101 | same | effects for attack; `ko` = hit |
| `npp-rose` | Rose Astronaut | `npp-rose.png` | character_pink | 84 x 101 | same | effects for attack; `ko` = hit |
| `npp-gold` | Gold Astronaut | `npp-gold.png` | character_yellow | 84 x 101 | same | effects for attack; `ko` = hit |
| `npp-sand` | Sand Astronaut | `npp-sand.png` | character_beige | 84 x 101 | same | effects for attack; `ko` = hit |
| `npp-ladybug` | Ladybug | `npp-ladybug.png` | ladybug | 126 x 122 | walk_a, walk_b, rest, fly | effects |
| `npp-snail` | Snail | `npp-snail.png` | snail | 128 x 106 | walk_a, walk_b, rest | effects |
| `npp-mouse` | Mouse | `npp-mouse.png` | mouse | 128 x 98 | walk_a, walk_b, rest | effects |
| `npp-frog` | Frog | `npp-frog.png` | frog | 128 x 128 | idle, jump, rest | effects |

## Pixel Platformer 1.2 (4 characters, added in v3)

- Source: https://kenney.nl/assets/pixel-platformer
- Archive (downloaded 2026-10-02): https://kenney.nl/media/pages/assets/pixel-platformer/33bb4921eb-1696667883/kenney_pixel-platformer.zip
- Author: Kenney (www.kenney.nl); license CC0-1.0
- Included notice, byte-for-byte: `public/assets/KENNEY_PIXEL_PLATFORMER_LICENSE.txt` ("Pixel Platformer (1.2) ... License: (Creative Commons Zero, CC0)")
- Poses taken from `Tiles/Characters/tile_<nnnn>.png` (24 x 24), scaled up 4x with nearest-neighbour so the pixels stay sharp.

| Catalog id | Label | File | Original tiles | Cell | Frames (in order) | Combat |
|---|---|---|---|---|---|---|
| `pixel-green` | Pixel Green | `pixel-green.png` | tile_0000, tile_0001 | 80 x 92 | tile A, tile B | effects |
| `pixel-blue` | Pixel Blue | `pixel-blue.png` | tile_0002, tile_0003 | 80 x 92 | same | effects |
| `pixel-pink` | Pixel Pink | `pixel-pink.png` | tile_0004, tile_0005 | 80 x 92 | same | effects |
| `pixel-yellow` | Pixel Yellow | `pixel-yellow.png` | tile_0006, tile_0007 | 80 x 92 | same | effects |

## Abstract Platformer (3 characters, added in v3)

- Source: https://kenney.nl/assets/abstract-platformer
- Archive (downloaded 2026-10-02): https://kenney.nl/media/pages/assets/abstract-platformer/a8f4badcb5-1677579172/kenney_abstract-platformer.zip
- Author: Kenney Vleugels (Kenney.nl); license CC0-1.0
- Included notice, byte-for-byte: `public/assets/KENNEY_ABSTRACT_PLATFORMER_LICENSE.txt` ("Abstract Platformer by Kenney Vleugels ... License (Creative Commons Zero, CC0)")
- Poses taken from `PNG/Players/Player <Colour>/player<Colour>_*.png`, scaled up 2x (bilinear).

| Catalog id | Label | File | Original character | Cell | Frames (in order) | Combat |
|---|---|---|---|---|---|---|
| `blob-blue` | Blue Blob | `blob-blue.png` | Player Blue | 128 x 108 | walk1-walk5, stand, up2, up1, hit, dead | effects for attack; `ko` = hit, dead |
| `blob-green` | Green Blob | `blob-green.png` | Player Green | 128 x 100 | same | effects for attack; `ko` = hit, dead |
| `blob-red` | Red Blob | `blob-red.png` | Player Red | 128 x 96 | same | effects for attack; `ko` = hit, dead |

## pzUH sprites on OpenGameArt (8 characters from 7 packs, added in v3)

- Author: pzUH, https://opengameart.org/users/pzuh; license CC0-1.0 (each page lists "License(s): CC0", checked 2026-10-02)
- The archives hold only images. The license record is `public/assets/OGA_PZUH_LICENSE.txt`, written for this project (it is not a copy of a file from the archives).
- Archives are fetched by `node scripts/build-characters.mjs --download` into `.asset-src/` (not committed) and checked against the SHA-256 in the script. Frames are taken from each archive's `png/` folder and scaled down to about 104 px tall (area average).

| Catalog id | Label | File | Source page | Archive | Cell | Walk / idle / attack / ko frames | Combat |
|---|---|---|---|---|---|---|---|
| `knight` | Knight | `knight.png` | https://opengameart.org/content/the-knight-free-sprite | https://opengameart.org/sites/default/files/FreeKnight.zip | 110 x 104 | 10 / 10 / 5 / 4 | attack + ko frames |
| `santa` | Santa | `santa.png` | https://opengameart.org/content/santa-claus-free-sprites | https://opengameart.org/sites/default/files/SantaSprites.zip | 98 x 105 | 13 / 8 / none / none | effects |
| `ninja` | Ninja | `ninja.png` | https://opengameart.org/content/ninja-adventure-free-sprite | https://opengameart.org/sites/default/files/NinjaAdventure.zip | 124 x 105 | 10 / 10 / 5 / 4 | attack + ko frames |
| `cowgirl` | Cowgirl | `cowgirl.png` | https://opengameart.org/content/adventurer-girl-free-sprite | https://opengameart.org/sites/default/files/Adventure%20Girl.zip | 104 x 104 | 8 / 10 / 7 / 4 | attack + ko frames |
| `cowboy` | Cowboy | `cowboy.png` | https://opengameart.org/content/temple-run-free-sprite | https://opengameart.org/sites/default/files/TempleRun.zip | 86 x 104 | 10 / 10 / none / none | effects |
| `cat` | Cat | `cat.png` | https://opengameart.org/content/cat-dog-free-sprites | https://opengameart.org/sites/default/files/CatnDog.zip | 126 x 104 | 10 / 10 / none / 1 (hurt) | effects for attack |
| `dog` | Dog | `dog.png` | https://opengameart.org/content/cat-dog-free-sprites | https://opengameart.org/sites/default/files/CatnDog.zip | 124 x 104 | 10 / 10 / none / 1 (hurt) | effects for attack |
| `dino` | Dino | `dino.png` | https://opengameart.org/content/free-dino-sprites | https://opengameart.org/sites/default/files/FreeDinoSprite.zip | 128 x 60 | 10 / 10 / none / 4 | effects for attack |

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

## Heading font

- File: `public/assets/fonts/fraunces-latin.woff2` (Latin subset, variable weight 500-700, unchanged)
- Font: Fraunces by Undercase Type (Phaedra Charles and Flavia Zimbardi), https://github.com/undercasetype/Fraunces
- Downloaded 2026-10-01 from Google Fonts (`fonts.gstatic.com/s/fraunces/v38`)
- License: SIL Open Font License 1.1. Included notice, byte-for-byte: `public/assets/fonts/FRAUNCES_OFL.txt`

The site's look takes cues from Hearthstone's dark tavern pages, but uses no Blizzard artwork, logos
or fonts.

## Site icon

- Files: `public/favicon.svg`, `public/favicon.ico`, `public/apple-touch-icon.png`
- A five-pip die face drawn for this project (no third-party artwork), same license as the code.
