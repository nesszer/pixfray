# Twitch application setup

Register a **confidential** application in [Twitch Developer Console](https://dev.twitch.tv/console/apps). Use your own account and add one OAuth redirect URL, `<origin>/auth/callback`, for every site in `site.config.js`, because sign-in returns to the site it started on:

- each entry in `origins` (the production site and the test site), for example `https://pixfray.xyz/auth/callback` and `https://staging.pixfray.xyz/auth/callback`;
- each entry in `channelDomains`, as `https://<domain>/auth/callback`.

Keep the client secret out of chat, GitHub, OBS URLs, and screenshots. Run `pwsh -NoProfile -File scripts/configure-twitch.ps1` locally. It prompts for the secret without echoing it and saves it to `~/.pixfray/secrets.json`, outside the repo.

Chat reaches the game through a Twitch EventSub webhook (`channel.chat.message`) that calls the Worker at `/api/eventsub`. Nothing runs on the OBS PC, and there is no relay.

**One site at a time.** Both sites use this one Twitch app, and Twitch allows only one `channel.chat.message` subscription per channel and reading account, whatever the callback URL. Sites that read chat as the same account (no chat bot, or the same bot) conflict; sites with different bot accounts in `site.config.js` (`bot`) don't. So only one of the live site and the test site can receive chat at a time. If chat is connected on the other site, **Connect chat** says so and offers to move it here; moving it deletes the other site's subscription and that site pauses within an hour (its hourly check finds the subscription gone). To run both at once, register a second Twitch app for the test site.

To connect a site:

1. Deploy the Worker (the callback must be the public https site; Twitch cannot reach localhost).
2. Sign in as the owner account (`owner.login` in `site.config.js`) at `/auth/login?connect=1`. This grants `moderation:read` (current moderator checks), `user:read:chat`, `user:bot` and `channel:bot`, which Twitch requires before it will deliver chat to the app.
3. Open `/admin/` and click **Connect chat**. The Worker creates exactly one webhook subscription with an app token and deletes stale ones. Until Twitch verifies the webhook, the page shows "waiting for Twitch to verify the webhook"; the room re-checks a pending subscription every 3 minutes and shows a failed verification instead of waiting forever. If Twitch reports missing authorization, the page links to **Reconnect Twitch** (`/auth/login?connect=1`); sign in again and click Connect chat.

The webhook secret is derived from `AUTH_SECRET`, so there is no extra secret to set. The room re-checks the subscription at Twitch every hour and pauses duels ("Duels paused · chat offline") if Twitch revoked or removed it. Disconnect chat on `/admin/` deletes the subscription.

## PixFray chat bot

With `bot` set for a site in `site.config.js`, chat is read and answered by that bot account instead:

1. Sign the bot account in at `/auth/login?bot=1` (`user:read:chat`, `user:write:chat`, `user:bot`). Only the account named in `bot` is accepted.
2. Each broadcaster allows the bot at `/auth/login?channel=<channel>&connect=bot` (scope `channel:bot`), or makes it a moderator, then clicks **Connect chat** on `/admin/`.
3. Typing `/mod <bot>` in chat lets the bot answer more than one command a second.

In bot mode the subscription reads as the bot, so the owner's `connect=1` sign-in above isn't the chat connection.

## Other channels

Other channels join by signing in on `/start/` (docs/STREAMER_SETUP.md). Their sign-in asks only for
`moderation:read`, so the channel's mods can use its mod controls; they use StreamElements for chat,
so they need no chat scopes. No viewer needs chat access permissions to customize a profile. Ranked duels require a saved Twitch-linked profile.

The code/deployment dashboard additionally needs a repo-scoped GitHub integration and GitHub Actions deployment secrets. These prerequisites are shown as unconfigured until provided; they do not silently grant moderators deployment access.
