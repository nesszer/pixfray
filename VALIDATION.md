> v1-era record (2026-10-01), kept for history. It describes the first overlay, before v2 was deployed. For the current state read VALIDATION_V2.md (checks and spec audit) and HANDOFF.md.

# Validation — 2026-10-01

Deployed: https://chat.miolaf.xyz
OBS URL: https://chat.miolaf.xyz/overlay.html?channel=nesszerra&size=64&cap=50
Demo: https://chat.miolaf.xyz/overlay.html?channel=nesszerra&demo=1&debug=1&size=64&cap=50

## Passed
- Cloudflare cf build and deploy, assets-only Worker, 14 static files.
- Active miolaf.xyz zone reports Free Website. New chat subdomain was empty before deployment. Apex records were not modified.
- Local and deployed Chromium smoke checks: URL setup, transparent painted sprites, viewport resize, commands, local appearance persistence, character cap, moderation, reload, reconnect.
- Real anonymous Twitch chat join for nesszerra in both Chromium and OBS.
- No page errors in browser smoke checks.
- Native OBS 32.2.2 / obs-websocket 5.7.4: hosted demo and live connection in new Mini Chat — Test scene.
- Test browser sources match existing 1920×1200 OBS canvas. Global video settings unchanged.
- Short final OBS sample: ~60 FPS, 187 frames, 0 skipped rendering frames. Eight demo characters. Overall OBS CPU ~0.39%; this is a short functional check, not a performance benchmark.
- Original active Scene 2 restored. Test scene retained with Demo enabled and Live disabled. Toggle those sources to use Live.
- npm audit reports zero vulnerabilities after upgrading cf and overriding undici to 7.30.0.
- Kenney poses and original CC0 notice checked by asset agent.

## Limits
- User skipped sending real manual Twitch commands. End-to-end command behavior was verified with synthetic IRC events; actual new-message/command reception on the user's channel remains unverified.
- Anonymous IRC works in current checks but Twitch documents authenticated IRC/EventSub. Keep this as an alpha until authenticated integration is added.
- Eight-character native OBS check does not establish performance at 50/100.
- Customization is local to the OBS/browser profile; no shared viewer editor or moderator dashboard.
- Direct Python HTTP checks receive Cloudflare 1010; real Chromium and OBS requests succeed. No domain security settings were weakened.
- Source is MIT and packaged for GitHub; no GitHub repository was created or published during this run.
- Previous miolafff test Worker was left intact under the user's recoverable-removal policy.

## Reproduce
Node 22.18+, npm install, npm run dev.
npm test uses installed Chrome at its standard Windows path. Set MINI_BASE_URL to the deployed origin to test production.
