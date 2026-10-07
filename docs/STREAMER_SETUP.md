# Streamer setup

This guide is for a streamer adding PixFray to their Twitch channel. After you sign in (step 1),
steps 2 to 4 below match the three steps of **Stream setup** on the mod controls page
(`/admin/?channel=<you>#chat`), in the same order and under the same titles. pixfray.xyz answers
chat with its own bot account, `pixfray`; channels that still take chat from StreamElements see
the StreamElements steps instead (see "Channels that use StreamElements" below). Each step holds its own buttons and turns Done by itself once it
works. Setup takes about 10 minutes.

## 1. Sign in on /start

Open `https://pixfray.xyz/start/` and click **Sign in with Twitch**, as the Twitch account you
stream on. PixFray turns on for that channel only; nobody can turn it on for someone else's.

- Up to 200 channels can be on. If PixFray is full, /start says so; you can also run your own copy
  from the code on GitHub.
- PixFray turns on at once if your Twitch account is at least 30 days old and you are Affiliate or
  Partner or have a saved past broadcast. Otherwise, or if Twitch can't be asked about past
  broadcasts, the sign-up waits for the site owner's approval; sign in on /start later to check.
- Twitch asks to let PixFray read your moderator list (`moderation:read`), so your mods can open
  your mod controls too, and to let the PixFray bot into your chat (`channel:bot`). The bot posts
  as its own account. PixFray never posts in chat as you and never changes your channel.
- If you cancel those permissions, /start offers **Set up without these permissions**. Only you
  can then open your mod controls, and the bot stays out of your chat, until you click **Add the
  PixFray bot** and **Connect mod access** in the checklist.
- If Twitch signs you in as the wrong account, PixFray turns on for that account instead. Log out
  of twitch.tv, sign in again as your streaming account, and ask the owner to turn the other one off.

After sign-in you land on the Stream setup tab of your mod controls. Later, opening `/admin/` while
signed in takes you straight to your channel, and signing in or out keeps you on the same page.

## 2. Add the overlay to OBS

Under "Add the overlay to OBS", click **Copy link**. In OBS add a Browser Source, paste the whole
link and set 1920 × 1080 at 30 FPS. Turn off "Shutdown source when not visible".

The step **Add the overlay to OBS** turns to Done within 10 seconds of the source loading.

## 3. Add the PixFray bot to your chat

If you allowed the bot when you signed up, chat connects by itself as the page opens and this
step is already Done. Otherwise click **Add the PixFray bot**, approve on Twitch, and you come back
with chat connected.

- Type `/mod pixfray` in your chat. Twitch lets a bot that isn't a moderator answer only about one
  command a second.
- Type `!fray` to test. The bot answers 12 commands: `!challenge`, `!fight`, `!decline`,
  `!rematch`, `!checkin`, `!wallet`, `!pay`, `!pet`, `!elo`, `!ranks`, `!fray` and `!look`. The
  **Chat commands** section below the checklist adds your own text commands.
- If StreamElements is also in your chat, turn off its Duel module (Chat bot, then Modules), or
  its `!duel` and `!accept` answer next to PixFray.

A moderator, or the site owner looking at your channel, sees **Connect chat** instead. It works
once you allowed the bot or made it a moderator.

## 4. Let your moderators help (optional)

**Let your moderators help** is Done when the moderator-list permission is stored. If you skipped
it, click **Connect mod access** and approve the permission while signed in to Twitch as yourself.

Moderators can edit chat commands, use Clear arena, change the balance and review viewer sprites.
Only you (or the site owner) can click **Reset all ranks**, **Turn PixFray off** or move chat from
another site.

The step reads differently depending on who looks at it. You, the broadcaster, get the button.
A moderator, or the site owner looking at your channel, is told that you have to connect it.

Mod access can lapse: the stored permission is dropped after 90 days without use, and using
the mod controls keeps it alive. A lapsed step shows an "Expired" badge and the button reads
**Reconnect mod access**. Until you click it, your moderators can't sign in to your mod controls.

## 5. Review viewer sprites

Viewers can turn any picture into a pixel sprite on your fighter page. Nothing reaches the stream
until you or a moderator approves it under **Viewer sprites waiting for review** on the
Characters tab. Approving puts the viewer in their sprite; **Turn down** drops the picture; an
approved sprite can be removed later. Each viewer can send 6 a day; the AI redraw is limited to
3 per viewer and 60 per channel a day.

## Channels that use StreamElements

Channels that set PixFray up before the bot, and sites without a bot (`bot` unset in
`site.config.js`), take chat from StreamElements custom commands. While StreamElements is the chat
source, the checklist shows the two steps below, and **Add the PixFray bot** becomes an optional
switch: once the bot connects, StreamElements stops answering PixFray commands.

### Turn off the StreamElements Duel module

StreamElements' own Duel game answers `!duel`, `!accept` and `!deny` at the same time as PixFray.
In StreamElements go to Chat bot, then Modules, and switch off Duel, or type
`!module duel disable` in chat. Then tick **I turned off the Duel module**.

### Add the commands to StreamElements

The table in **Add the chat commands to StreamElements** lists 12 commands: `!challenge`, `!fight`, `!decline`,
`!rematch`, `!checkin`, `!wallet`, `!pay`, `!pet`, `!elo`, `!ranks`, `!fray` and `!look`. You can rename them first and click **Save names**.
Keep `!pay` off `!give`: StreamElements' built-in `!givepoints` already answers to `!give`.

The commands run as StreamElements custom commands; Nightbot and Fossabot can't run them.

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

Moderators can also rename these commands and tick the Duel module; only you (or the site owner)
can click **New key**.

## If something doesn't work

The same answers are under "If something doesn't work" at the bottom of Stream setup.

- **The overlay is blank in OBS:** paste the full link again, check 1920 × 1080, turn off "Shutdown
  source when not visible", then right-click the source and choose Refresh.
- **The bot doesn't answer:** check that **Add the PixFray bot** is Done, then type `!fray debug`;
  the bot health line under Twitch chat connection shows what it last heard and sent.
- **The bot doesn't answer anything at all:** it may be turned off. Type `!fray on` (broadcaster or
  a mod), or turn on **Bot answers commands** under Rules, Chat bot. `!fray off` turns it off again.
- **The bot answers only every other command:** type `/mod pixfray` in your chat.
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
