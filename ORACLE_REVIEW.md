# Temporary Oracle consultation
Oracle skill + oracle-temporary-chat MCP; prompt-only temporary browser chat, no attached files. Session twitch-mini-v1-review completed with GPT-5.6 Sol, Extra High requested.

Advice applied:
- Ship static Canvas overlay first; defer OAuth, EventSub, DO, editor, progression and AI.
- Isolate the chat adapter.
- Spawn from observed messages rather than inferred viewer presence.
- Cap characters, expire inactive users, include demo/reconnect/preferences.
- Anonymous IRC is expedient for an alpha but not Twitch's supported documented contract.
- Check transparent rendering and actual OBS behavior.

Comparison:
- hxAvatars (MIT): smallest existing static candidate; assets/behavior still need adaptation.
- Evotars (MIT): broader features; PostgreSQL port adds work.
- Own small Canvas implementation: selected for immediate narrow scope and no runtime game-engine dependency.
- Kenney Platformer Characters (CC0): five compatible characters selected.
- Universal LPC: richer wardrobe; mixed art licensing and animation compatibility deferred.
- Stream-Walkers: redistribution restrictions; excluded.

Sources:
https://github.com/haliphax/hxavatars
https://github.com/inferst/evotars-app
https://kenney.nl/assets/platformer-characters
https://dev.twitch.tv/docs/chat/irc/
https://developers.cloudflare.com/workers/static-assets/
