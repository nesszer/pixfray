# Twitch application setup

Register a **confidential** application in [Twitch Developer Console](https://dev.twitch.tv/console/apps). Use your own account and these OAuth redirect URLs:

- `https://chat.miolaf.xyz/auth/callback`
- `https://test.chat.miolaf.xyz/auth/callback`

Keep the client secret out of chat, GitHub, OBS URLs, and screenshots. Run `pwsh -NoProfile -File scripts/configure-twitch.ps1` locally. It prompts for the secret without echoing it and saves ignored local configuration.

Chat reaches the game through a Twitch EventSub webhook (`channel.chat.message`) that calls the Worker at `/api/eventsub`. Nothing runs on the OBS PC, and there is no relay.

**One site at a time.** Both sites use this one Twitch app, and Twitch allows only one `channel.chat.message` subscription per channel and app, whatever the callback URL. So only one of `chat.miolaf.xyz` and `test.chat.miolaf.xyz` can receive chat at a time. If chat is connected on the other site, **Connect chat** says so and offers to move it here; moving it deletes the other site's subscription and that site pauses within an hour (its hourly check finds the subscription gone). To run both at once, register a second Twitch app for the test site.

To connect a site:

1. Deploy the Worker (the callback must be the public https site; Twitch cannot reach localhost).
2. Sign in as **nesszerra** at `/auth/login?connect=1`. This grants `moderation:read` (current moderator checks), `user:read:chat`, `user:bot` and `channel:bot`, which Twitch requires before it will deliver chat to the app.
3. Open `/admin/` and click **Connect chat**. The Worker creates exactly one webhook subscription with an app token and deletes stale ones. Until Twitch verifies the webhook, the page shows "waiting for Twitch to verify the webhook"; the room re-checks a pending subscription every 3 minutes and shows a failed verification instead of waiting forever. If Twitch reports missing authorization, the page links to **Reconnect Twitch** (`/auth/login?connect=1`); sign in again and click Connect chat.

The webhook secret is derived from `AUTH_SECRET`, so there is no extra secret to set. The room re-checks the subscription at Twitch every hour and pauses duels ("Duels paused · chat offline") if Twitch revoked or removed it. Disconnect chat on `/admin/` deletes the subscription.

`miolafff` remains disabled until its owner authorizes onboarding. No viewer needs chat access permissions to customize a profile. Ranked duels require a saved Twitch-linked profile.

The code/deployment dashboard additionally needs a repo-scoped GitHub integration and GitHub Actions deployment secrets. These prerequisites are shown as unconfigured until provided; they do not silently grant moderators deployment access.
