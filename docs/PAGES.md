# Pages and overlay options

## Pages

| Page | What it is |
|---|---|
| `/` | What PixFray is, with a duel playing. A returning viewer gets a "Back to <channel>" button. |
| `/?channel=<login>` | That channel's fighter page. A signed-in viewer can turn a picture into their own sprite under **Your own sprite** (an optional AI redraw first). It joins their character list once a mod approves it. |
| `/play/` | Picks the channel. |
| `/intro/` | Redirects to `/`. |
| `/start/` | Streamer sign-up. |
| `/admin/?channel=<login>` | The mod controls. A signed-in streamer who opens `/admin/` lands on their own channel. Viewer sprites waiting for review are at the top of the Characters tab. |

Signing in or out comes back to the same page, channel and tab.

## Overlay link options

The overlay link is `/overlay.html?channel=<login>` plus any of these:

| Option | What it does |
|---|---|
| `channel` | The channel to show. Without it, the overlay shows `defaultChannel` from `site.config.js`. |
| `size=24..96` | Fighter size in pixels (clamped; default 60). |
| `cap=1..100` | At most this many fighters (whole numbers; anything else means no limit of its own). With `arena=1`, the lower of this and the channel's on-stream limit applies. |
| `arena=1` | Show duels. |
| `announce=off\|top\|bottom` | Where the duel banner shows. `off`, the default, shows none. The channel setting in the mod controls overrides it. |
| `sound=1` | Quiet synthesized duel sounds. |
| `bubbles=0` | No speech bubbles (chat messages or win taunts). Duels still show. |
| `fx=off` | No hit glow, sparks or knockout push-in. |
| `demo=1` | A preview with fake chatters. |
| `debug=1` | Debug readout. |

The overlay joins chat over anonymous read-only Twitch IRC to show who is chatting
([public/chat.js](../public/chat.js)). Twitch may change anonymous access. Duels and ranks go
through the Worker.
