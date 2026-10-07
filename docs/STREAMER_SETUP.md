# Streamer setup

This guide is for a streamer adding PixFray to their Twitch channel. After you sign in (step 1),
steps 2 to 5 below match the four steps of **Stream setup** on the mod controls page
(`/admin/?channel=<you>#chat`), in the same order and under the same titles. Each step holds its own buttons and turns Done by itself once it
works. Setup takes about 10 minutes.

## 1. Sign in on /start

Open `https://pixfray.xyz/start/` and click **Sign in with Twitch**, as the Twitch account you
stream on. PixFray turns on for that channel only; nobody can turn it on for someone else's.

- Up to 200 channels can be on. If PixFray is full, /start says so; you can also run your own copy
  from the code on GitHub.
- PixFray turns on at once if your Twitch account is at least 30 days old and you are Affiliate or
  Partner or have a saved past broadcast. Otherwise, or if Twitch can't be asked about past
  broadcasts, the sign-up waits for the site owner's approval; sign in on /start later to check.
- Twitch asks to let PixFray read your moderator list
  (`moderation:read`), so your mods can open your mod controls too. PixFray never posts in chat as
  you and never changes your channel.
- If you cancel that permission, /start offers **Set up without mod access**. Only you can then
  open your mod controls, until you click **Connect mod access** in the checklist.
- If Twitch signs you in as the wrong account, PixFray turns on for that account instead. Log out
  of twitch.tv, sign in again as your streaming account, and ask the owner to turn the other one off.

After sign-in you land on the Stream setup tab of your mod controls. Later, opening `/admin/` while
signed in takes you straight to your channel, and signing in or out keeps you on the same page.

## 2. Add the overlay to OBS

Under "Add the overlay to OBS", click **Copy link**. In OBS add a Browser Source, paste the whole
link and set 1920 × 1080 at 30 FPS. Turn off "Shutdown source when not visible".

The step **Add the overlay to OBS** turns to Done within 10 seconds of the source loading.

## 3. Turn off the StreamElements Duel module

StreamElements' own Duel game answers `!duel`, `!accept` and `!deny` at the same time as PixFray.
In StreamElements go to Chat bot, then Modules, and switch off Duel, or type
`!module duel disable` in chat. Then tick **I turned off the Duel module**.

## 4. Add the commands to StreamElements

The table in **Add the chat commands to StreamElements** lists 12 commands: `!challenge`, `!fight`, `!decline`,
`!rematch`, `!checkin`, `!wallet`, `!pay`, `!pet`, `!elo`, `!ranks`, `!fray` and `!look`. You can rename them first and click **Save names**.
Keep `!pay` off `!give`: StreamElements' built-in `!givepoints` already answers to `!give`.

For each row, in StreamElements go to Chat bot, then Commands, then Custom commands, and click Add
new command:

- Command name: the name without the `!`.
- Reply: click **Copy reply** in that row and paste the whole line. The table shows only where the
  reply points (`/api/se/<you>/challenge?k=…`), so the page is safe to show on stream; the key is
  only in what Copy reply puts on the clipboard.
- Advanced settings: set the user and global cooldowns to 0, then click Activate command.

Add commands in the StreamElements dashboard, not with `!command add` in chat: the reply contains
your channel's key, and chat would show it to everyone. If the key leaks, click **New key** and
paste the replies again.

The key is the only secret. StreamElements sends the viewer's id and name with each command, so
anyone who holds your key can send commands as any viewer of your channel. Don't show the copied replies on stream,
and click **New key** if you think the key has leaked.

Type `!decline` in your chat to test. Each row shows **Working** once its command arrives, and the
first command switches the channel to StreamElements on its own.

Optional: add a StreamElements timer every 15 to 20 minutes with the text from **Copy timer
message**, so new viewers learn how to join. PixFray never posts on its own.

## 5. Let your moderators help (optional)

**Let your moderators help** is Done when the moderator-list permission is stored. If you skipped
it, click **Connect mod access** and approve the permission while signed in to Twitch as yourself.

Moderators can rename commands, tick the Duel module, use Clear arena and change the balance. Only you
(or the site owner) can click **New key**, **Reset all ranks**, **Turn PixFray off** or move chat from
another site.

The step reads differently depending on who looks at it. You, the broadcaster, get the button.
A moderator, or the site owner looking at your channel, is told that you have to connect it.

Mod access can lapse: the stored permission is dropped after 90 days without use, and using
the mod controls keeps it alive. A lapsed step shows an "Expired" badge and the button reads
**Reconnect mod access**. Until you click it, your moderators can't sign in to your mod controls.

## If something doesn't work

The same answers are under "If something doesn't work" at the bottom of Stream setup.

- **The overlay is blank in OBS:** paste the full link again, check 1920 × 1080, turn off "Shutdown
  source when not visible", then right-click the source and choose Refresh.
- **Two bots answer the same command:** the StreamElements Duel module is still on.
- **A command answers "wrong key":** copy that row's reply again and replace the old one.
- **Mod access expired:** your moderators can't open the mod controls. Click **Reconnect mod
  access** under **Let your moderators help** while signed in to Twitch as yourself.

## Turning PixFray off

At the bottom of the Stream setup tab, **Turn PixFray off** stops the overlay, the chat commands
and the viewer page on your channel. Fighters, ranks and settings are kept, and **Turn PixFray
back on** picks up where you left off. If the site owner turned your channel off, only the owner can
turn it back on. Other servers notice the change within about a minute. An
overlay that was already open keeps showing chatters until OBS reloads it; a stopped overlay checks
again every 5 minutes, so turning PixFray back on needs no OBS refresh.
