# Twitch application setup

Register a **confidential** application in [Twitch Developer Console](https://dev.twitch.tv/console/apps). Use your own account and these OAuth redirect URLs:

- `https://chat.miolaf.xyz/auth/callback`
- `https://test.chat.miolaf.xyz/auth/callback`
- `http://localhost:17563/callback` (the Windows relay)

Keep the client secret out of chat, GitHub, OBS URLs, and screenshots. Run `pwsh -NoProfile -File scripts/configure-twitch.ps1` locally. It prompts for the secret without echoing it and saves ignored local configuration.

After configuration/deployment, sign in on the test site. Connect broadcaster authorization as **nesszerra** to enable current Twitch moderator verification (`moderation:read`). The Windows relay separately authorizes `user:read:chat`, stores its tokens under Windows DPAPI, and pairs using the owner dashboard's short-lived pairing code. See [relay/README.md](relay/README.md).

`miolafff` remains disabled until its owner authorizes onboarding. No viewer needs chat access permissions to customize a profile. Ranked duels require a saved Twitch-linked profile.

The code/deployment dashboard additionally needs a repo-scoped GitHub integration and GitHub Actions deployment secrets. These prerequisites are shown as unconfigured until provided; they do not silently grant moderators deployment access.
