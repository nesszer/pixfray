# Character reserve

29 free characters, vetted on 2026-10-01 and ready to import later. None of them are bundled yet.

24 other characters, taken from this list and from the OpenGameArt packs by pzUH, were imported on
2026-10-02 with `scripts/build-characters.mjs` (see `ASSET_LICENSES.md`). Their rows were removed from the
table below.

How each row was vetted: the official archive was downloaded from the Kenney asset page, the
license file inside the archive was read, and the listed sprite files were opened to confirm they
exist and to measure them. Every pack below is by **Kenney Vleugels (Kenney.nl)** and licensed
**CC0-1.0** (https://creativecommons.org/publicdomain/zero/1.0/). Every listed frame is at most
128 x 128, so each character fits the atlas format in `public/assets/characters.json` without
scaling.

To import one: copy the poses into a single-row atlas (bottom-centre aligned in a fixed cell, pixels
unchanged), add the entry to `characters.json` (set `"combatFallback": "effects"` when there are no
attack frames), copy the license file from the archive into `public/assets/`, and add a row to
`ASSET_LICENSES.md`. `npm run test:unit` (`tests/content.test.mjs`) then checks that every frame
rectangle sits inside its image and that every character is listed in `ASSET_LICENSES.md`.

Frame columns: **walk** and **idle** are movement frames; **attack** and **ko** are combat frames.
"effects" means the overlay uses flash, shake and fade instead of drawn frames.

## Packs

| Pack | Page | Archive | License file in the archive |
|---|---|---|---|
| Platformer Art Deluxe (Platformer Art Complete Pack) | https://kenney.nl/assets/platformer-art-deluxe | https://kenney.nl/media/pages/assets/platformer-art-deluxe/cb30f83169-1677696393/kenney_platformer-art-deluxe.zip | `license.txt`: "License (CC0)" |
| Platformer Art Extended Enemies | https://kenney.nl/assets/platformer-art-extended-enemies | https://kenney.nl/media/pages/assets/platformer-art-extended-enemies/38f1885b37-1677696504/kenney_platformer-art-extended-enemies.zip | `license.txt`: "License (CC0)" |
| Abstract Platformer | https://kenney.nl/assets/abstract-platformer | https://kenney.nl/media/pages/assets/abstract-platformer/a8f4badcb5-1677579172/kenney_abstract-platformer.zip | `License.txt`: "License (Creative Commons Zero, CC0)" |
| Pixel Platformer | https://kenney.nl/assets/pixel-platformer | https://kenney.nl/media/pages/assets/pixel-platformer/33bb4921eb-1696667883/kenney_pixel-platformer.zip | `License.txt`: "License: (Creative Commons Zero, CC0)" |
| Scribble Platformer | https://kenney.nl/assets/scribble-platformer | https://kenney.nl/media/pages/assets/scribble-platformer/d2a7aaf79a-1674932936/kenney_scribble-platformer.zip | `License.txt`: "License: (Creative Commons Zero, CC0)" |

## Characters

| # | Name | Pack | Files (inside the archive) | Size (px) | walk | idle | attack | ko |
|---|---|---|---|---|---|---|---|---|
| 1 | Yellow Alien | Platformer Art Deluxe | `Extra animations and enemies/Alien sprites/alienYellow_*.png` | up to 70 x 100 | walk1, walk2 | stand | effects | hurt |
| 2 | Grey Blob | Abstract Platformer | `PNG/Players/Player Grey/playerGrey_*.png` (18 poses) | up to 64 x 36 | walk1-walk5 | stand | effects | hit, dead |
| 3 | Green Hand | Scribble Platformer | `PNG/Default/character_handGreen.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 4 | Purple Hand | Scribble Platformer | `PNG/Default/character_handPurple.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 5 | Red Hand | Scribble Platformer | `PNG/Default/character_handRed.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 6 | Yellow Hand | Scribble Platformer | `PNG/Default/character_handYellow.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 7 | Green Round | Scribble Platformer | `PNG/Default/character_roundGreen.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 8 | Purple Round | Scribble Platformer | `PNG/Default/character_roundPurple.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 9 | Red Round | Scribble Platformer | `PNG/Default/character_roundRed.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 10 | Yellow Round | Scribble Platformer | `PNG/Default/character_roundYellow.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 11 | Green Square | Scribble Platformer | `PNG/Default/character_squareGreen.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 12 | Purple Square | Scribble Platformer | `PNG/Default/character_squarePurple.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 13 | Red Square | Scribble Platformer | `PNG/Default/character_squareRed.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 14 | Yellow Square | Scribble Platformer | `PNG/Default/character_squareYellow.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 15 | Bat | Platformer Art Extended Enemies | `Enemy sprites/bat*.png` | up to 88 x 47 | bat, fly | hang | effects | hit, dead |
| 16 | Bee | Platformer Art Extended Enemies | `Enemy sprites/bee*.png` | up to 61 x 48 | bee, fly | bee | effects | hit, dead |
| 17 | Fly | Platformer Art Extended Enemies | `Enemy sprites/fly*.png` | up to 65 x 45 | fly, fly_fly | fly | effects | hit, dead |
| 18 | Ghost | Platformer Art Extended Enemies | `Enemy sprites/ghost*.png` | 51 x 73 | ghost, normal | normal | effects | hit, dead |
| 19 | Spider | Platformer Art Extended Enemies | `Enemy sprites/spider*.png` | up to 77 x 53 | walk1, walk2 | spider | effects | hit, dead |
| 20 | Worm | Platformer Art Extended Enemies | `Enemy sprites/worm*.png` | 63 x 23 | worm, walk | worm | effects | hit, dead |
| 21 | Green Slime | Platformer Art Extended Enemies | `Enemy sprites/slimeGreen*.png` | up to 57 x 34 | slimeGreen, walk | slimeGreen | effects | hit, squashed, dead |
| 22 | Blue Slime | Platformer Art Extended Enemies | `Enemy sprites/slimeBlue*.png` | up to 57 x 34 | slimeBlue, blue | slimeBlue | effects | hit, squashed, dead |
| 23 | Snake | Platformer Art Extended Enemies | `Enemy sprites/snake.png`, `snake_walk.png`, `snake_hit.png`, `snake_dead.png` | 63 x 23 | snake, walk | snake | effects | hit, dead |
| 24 | Slime Block | Platformer Art Extended Enemies | `Enemy sprites/slimeBlock*.png` | 51 x 50 | slimeBlock | slimeBlock | effects | hit, dead |
| 25 | Grass Block | Platformer Art Extended Enemies | `Enemy sprites/grassBlock*.png` | 71 x 70 | grassBlock, jump | grassBlock | effects | hit, dead |
| 26 | Barnacle | Platformer Art Extended Enemies | `Enemy sprites/barnacle*.png` | up to 51 x 58 | barnacle, bite | barnacle | bite | hit, dead |
| 27 | Beige Pixel Astronaut | Pixel Platformer | `Tiles/Characters/tile_0009.png`, `tile_0010.png` | 24 x 24 | 2 frames | tile_0009 | effects | effects |
| 28 | Pixel Block Face | Pixel Platformer | `Tiles/Characters/tile_0011.png`, `tile_0012.png` | 24 x 24 | 2 frames | tile_0011 | effects | effects |
| 29 | Pixel Bat | Pixel Platformer | `Tiles/Characters/tile_0024.png` to `tile_0026.png` | 24 x 24 | 3 frames | tile_0024 | effects | effects |

## Checked and left out

- Already bundled from the reserve: Blue, Green and Red Blob (Abstract Platformer); Frog, Ladybug, Mouse and
  Snail (the New Platformer Pack versions, drawn at higher resolution, replace the Extended Enemies ones); and
  the four Pixel Platformer astronauts (shown as Pixel Green, Pixel Blue, Pixel Pink and Pixel Yellow).
- Toon Characters 1 (https://kenney.nl/assets/toon-characters): all 6 characters are already in the
  launch roster.
- Platformer Art Deluxe aliens Beige, Blue, Green and Pink: already in the launch roster.
- Platformer Pack Remastered (https://kenney.nl/assets/platformer-pack-remastered, CC0): its aliens
  redraw the ones above, so they would be near-duplicates.
- `snakeLava` and `snakeSlime` (Extended Enemies): 147 px tall, over the 128 px frame limit.
- Platformer Art Deluxe players P1, P2 and P3 (`Base pack/Player/p1-p3_*.png`): older drawings of
  the green, blue and pink aliens already in the launch roster, so they would be near-duplicates.
- Tiny Dungeon (https://kenney.nl/assets/tiny-dungeon, CC0): 16 px single-frame tiles with numbered
  file names only; not itemised.

Pixel Platformer characters are 24 x 24 pixel art. Draw them with image smoothing off
(`imageSmoothingEnabled = false`) so they stay sharp when the overlay scales them up.
