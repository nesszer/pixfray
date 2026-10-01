# Character reserve

40 free characters, vetted on 2026-10-01 and ready to import later. None of them are bundled yet.

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
| 2 | Green Pixel Astronaut | Pixel Platformer | `Tiles/Characters/tile_0000.png`, `tile_0001.png` | 24 x 24 | 2 frames | tile_0000 | effects | effects |
| 3 | Blue Pixel Astronaut | Pixel Platformer | `Tiles/Characters/tile_0002.png`, `tile_0003.png` | 24 x 24 | 2 frames | tile_0002 | effects | effects |
| 4 | Pink Pixel Astronaut | Pixel Platformer | `Tiles/Characters/tile_0004.png`, `tile_0005.png` | 24 x 24 | 2 frames | tile_0004 | effects | effects |
| 5 | Blue Blob | Abstract Platformer | `PNG/Players/Player Blue/playerBlue_*.png` (18 poses) | up to 64 x 40 | walk1-walk5 | stand | effects | hit, dead |
| 6 | Green Blob | Abstract Platformer | `PNG/Players/Player Green/playerGreen_*.png` (18 poses) | up to 64 x 39 | walk1-walk5 | stand | effects | hit, dead |
| 7 | Grey Blob | Abstract Platformer | `PNG/Players/Player Grey/playerGrey_*.png` (18 poses) | up to 64 x 36 | walk1-walk5 | stand | effects | hit, dead |
| 8 | Red Blob | Abstract Platformer | `PNG/Players/Player Red/playerRed_*.png` (18 poses) | up to 64 x 38 | walk1-walk5 | stand | effects | hit, dead |
| 9 | Green Hand | Scribble Platformer | `PNG/Default/character_handGreen.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 10 | Purple Hand | Scribble Platformer | `PNG/Default/character_handPurple.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 11 | Red Hand | Scribble Platformer | `PNG/Default/character_handRed.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 12 | Yellow Hand | Scribble Platformer | `PNG/Default/character_handYellow.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 13 | Green Round | Scribble Platformer | `PNG/Default/character_roundGreen.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 14 | Purple Round | Scribble Platformer | `PNG/Default/character_roundPurple.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 15 | Red Round | Scribble Platformer | `PNG/Default/character_roundRed.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 16 | Yellow Round | Scribble Platformer | `PNG/Default/character_roundYellow.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 17 | Green Square | Scribble Platformer | `PNG/Default/character_squareGreen.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 18 | Purple Square | Scribble Platformer | `PNG/Default/character_squarePurple.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 19 | Red Square | Scribble Platformer | `PNG/Default/character_squareRed.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 20 | Yellow Square | Scribble Platformer | `PNG/Default/character_squareYellow.png` | 64 x 64 | single PNG | single PNG | effects | effects |
| 21 | Bat | Platformer Art Extended Enemies | `Enemy sprites/bat*.png` | up to 88 x 47 | bat, fly | hang | effects | hit, dead |
| 22 | Bee | Platformer Art Extended Enemies | `Enemy sprites/bee*.png` | up to 61 x 48 | bee, fly | bee | effects | hit, dead |
| 23 | Fly | Platformer Art Extended Enemies | `Enemy sprites/fly*.png` | up to 65 x 45 | fly, fly_fly | fly | effects | hit, dead |
| 24 | Frog | Platformer Art Extended Enemies | `Enemy sprites/frog*.png` | up to 61 x 54 | frog, leap | frog | effects | hit, dead |
| 25 | Ghost | Platformer Art Extended Enemies | `Enemy sprites/ghost*.png` | 51 x 73 | ghost, normal | normal | effects | hit, dead |
| 26 | Ladybug | Platformer Art Extended Enemies | `Enemy sprites/ladyBug*.png` | up to 61 x 42 | ladyBug, walk | ladyBug | effects | hit |
| 27 | Mouse | Platformer Art Extended Enemies | `Enemy sprites/mouse*.png` | up to 59 x 35 | mouse, walk | mouse | effects | hit, dead |
| 28 | Snail | Platformer Art Extended Enemies | `Enemy sprites/snail*.png` | up to 60 x 40 | snail, walk | snail | effects | hit, shell |
| 29 | Spider | Platformer Art Extended Enemies | `Enemy sprites/spider*.png` | up to 77 x 53 | walk1, walk2 | spider | effects | hit, dead |
| 30 | Worm | Platformer Art Extended Enemies | `Enemy sprites/worm*.png` | 63 x 23 | worm, walk | worm | effects | hit, dead |
| 31 | Green Slime | Platformer Art Extended Enemies | `Enemy sprites/slimeGreen*.png` | up to 57 x 34 | slimeGreen, walk | slimeGreen | effects | hit, squashed, dead |
| 32 | Blue Slime | Platformer Art Extended Enemies | `Enemy sprites/slimeBlue*.png` | up to 57 x 34 | slimeBlue, blue | slimeBlue | effects | hit, squashed, dead |
| 33 | Snake | Platformer Art Extended Enemies | `Enemy sprites/snake.png`, `snake_walk.png`, `snake_hit.png`, `snake_dead.png` | 63 x 23 | snake, walk | snake | effects | hit, dead |
| 34 | Slime Block | Platformer Art Extended Enemies | `Enemy sprites/slimeBlock*.png` | 51 x 50 | slimeBlock | slimeBlock | effects | hit, dead |
| 35 | Grass Block | Platformer Art Extended Enemies | `Enemy sprites/grassBlock*.png` | 71 x 70 | grassBlock, jump | grassBlock | effects | hit, dead |
| 36 | Barnacle | Platformer Art Extended Enemies | `Enemy sprites/barnacle*.png` | up to 51 x 58 | barnacle, bite | barnacle | bite | hit, dead |
| 37 | Yellow Pixel Astronaut | Pixel Platformer | `Tiles/Characters/tile_0006.png`, `tile_0007.png` | 24 x 24 | 2 frames | tile_0006 | effects | effects |
| 38 | Beige Pixel Astronaut | Pixel Platformer | `Tiles/Characters/tile_0009.png`, `tile_0010.png` | 24 x 24 | 2 frames | tile_0009 | effects | effects |
| 39 | Pixel Block Face | Pixel Platformer | `Tiles/Characters/tile_0011.png`, `tile_0012.png` | 24 x 24 | 2 frames | tile_0011 | effects | effects |
| 40 | Pixel Bat | Pixel Platformer | `Tiles/Characters/tile_0024.png` to `tile_0026.png` | 24 x 24 | 3 frames | tile_0024 | effects | effects |

## Checked and left out

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
