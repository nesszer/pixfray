// StreamElements chat source. Each game action is a StreamElements custom command whose reply is
// $(customapi <url>): the bot GETs /api/se/<channel>/<action>?k=..&id=..&u=..&d=..&t=..&m=.. and posts our reply.
// The trigger word lives only in StreamElements, so commands can be renamed there freely.
import { hiddenResults, PAIR_RATED_PER_DAY } from './game.js';
import { boostText } from './pets.js';

export const SE_PATH = /^\/api\/se\/([a-z0-9_]{1,25})\/([a-z]{1,16})$/;
export const SE_SUBSCRIPTION_ID = 'se-streamelements';   // marks StreamElements as the chat source in state.chat
export const SE_ACTIONS = ['challenge', 'accept', 'decline', 'rematch', 'top', 'elo', 'help', 'look', 'checkin', 'wallet', 'give', 'pet'];   // quick duels need no attack commands
export const SE_READ_ACTIONS = ['top', 'elo', 'help', 'look'];   // no game state, so they work while duels are paused
// StreamElements has a built-in !top that can't be edited, so the leaderboard command is !ranks.
export const DEFAULT_SE_NAMES = { challenge: '!challenge', accept: '!fight', decline: '!decline', rematch: '!rematch', top: '!ranks', elo: '!elo', help: '!fray', look: '!look', checkin: '!checkin', wallet: '!wallet', give: '!pay', pet: '!pet' };   // not !give: StreamElements' built-in !givepoints answers to that
export const LOST_TEXT = 'Lost in the arena? Type !fray';
export const MISSED_TEXT = "That move didn't land. Try again in a moment!";
export const OFF_TEXT = 'PixFray is off on this channel right now.';
const MAX_REPLY = 380;   // StreamElements cuts responses at 400 bytes

const reply = (body, status = 200) => new Response(String(body).slice(0, MAX_REPLY), { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// Keys are 24 random bytes as hex (randomHex in server/channel.js). Anything else is refused without waking the room.
export const SE_KEY = /^[a-f0-9]{48}$/;
export const WRONG_KEY_TEXT = 'PixFray: wrong key. Copy the commands again from the admin page.';
// Per-isolate memory of refused (channel, key) pairs: the first refusal reaches the room (it records rejected_at for the
// admin page), repeats within REFUSED_MS are answered here with no Durable Object request (Free plan quota).
const REFUSED_MS = 60000, REFUSED_MAX = 2000;
const refused = new Map();
export function forgetRefused() { refused.clear(); known.clear(); }
export const seKeyHash = async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).slice(0, 16), x => x.toString(16).padStart(2, '0')).join('');
// Per-isolate memory of each channel's current key hash (the room sends it as X-Se-Key). A key that doesn't match is
// refused here; one mismatch per MISMATCH_MS still reaches the room, so a freshly rotated key works within seconds.
const KNOWN_MS = 60000, MISMATCH_MS = 10000;
const known = new Map();

// GET /api/se/<channel>/<action>. The per-channel key is the authentication; the room checks it.
// channelState(channel) -> 'builtin' | 'on' | 'paused' | null (server/channels.js); tests may pass a channels list.
export async function handleStreamElements(request, env, { url, origin, channels = [], channelState, roomFetch, dropSubscription }) {
  if (request.method !== 'GET') return reply('Use GET', 405);
  const m = SE_PATH.exec(url.pathname);
  if (!m) return reply('Unknown command', 404);
  const [, channel, action] = m;
  // Cheap checks first: none of these touches AuthStore or a room.
  if (!SE_ACTIONS.includes(action)) return reply(LOST_TEXT);   // e.g. an old !attack/!strike/!heavy/!heal
  const q = name => (url.searchParams.get(name) || '').trim();
  const key = q('k');
  if (!key || key.length > 128) return reply('PixFray: missing key. Copy the commands again from the admin page.');
  if (!SE_KEY.test(key)) return reply(WRONG_KEY_TEXT);
  const now = Date.now(), hash = await seKeyHash(key), pair = channel + ':' + hash, hit = refused.get(pair);
  if (hit && now - hit < REFUSED_MS) return reply(WRONG_KEY_TEXT);
  const current = known.get(channel);
  if (current && now - current.at < KNOWN_MS && current.hash !== hash) {
    if (now - current.passedAt < MISMATCH_MS) return reply(WRONG_KEY_TEXT);
    current.passedAt = now;
  }
  const state = channelState ? await channelState(channel) : channels.includes(channel) ? 'builtin' : null;
  if (state === 'paused') return reply(OFF_TEXT);
  if (state !== 'builtin' && state !== 'on') return reply('PixFray is not enabled for this channel', 404);
  const body = {
    key,
    action,
    userId: q('id').slice(0, 32),
    username: q('u').replace(/^@/, '').toLowerCase().slice(0, 25),
    displayName: q('d').slice(0, 48),
    target: seTarget(q('t')),
    targetRaw: shown(q('t')),   // for the command log
    ...(action === 'give' ? { amount: q('a').slice(0, 16) } : {}),   // !give @name amount: $(2)
    messageId: q('m').slice(0, 64),
  };
  const r = await roomFetch(channel, '/se?origin=' + encodeURIComponent(origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  const sent = r.headers.get('X-Se-Key');
  if (sent && /^[a-f0-9]{32}$/.test(sent)) {
    if (known.size >= REFUSED_MAX) known.clear();
    known.set(channel, { hash: sent, at: Date.now(), passedAt: known.get(channel)?.passedAt || 0 });
  }
  if (r.status === 403 && typeof data.reply === 'string') {   // the room refused the key: remember the pair
    if (refused.size >= REFUSED_MAX) refused.clear();
    refused.set(pair, Date.now());
  }
  if (data.switchedFrom && dropSubscription) dropSubscription(data.switchedFrom);
  // always 200 so the bot shows the text; '' (a repeated message id) means post nothing
  return reply(typeof data.reply === 'string' ? data.reply : MISSED_TEXT);
}

// $(1) as sent by StreamElements -> a Twitch login, or '' for none. '-' means no argument; chat clients
// append invisible characters (U+E0000, U+034F) to repeated messages; those are stripped first. Extra leading @ and
// trailing punctuation ("@@bob", "@bob," or "bob!") still mean bob.
export function seTarget(raw) {
  const m = /^@*([a-z0-9_]{1,25})[,.!?;:]*$/i.exec(String(raw || '').replace(/[\u{E0000}-\u{E007F}\u034F\u180E\u200B-\u200D\u2060\uFEFF\s]/gu, ''));
  return m ? m[1].toLowerCase() : '';
}

// Text with invisible and non-ASCII characters written as \u{...}, for logs.
export const shown = raw => String(raw || '').slice(0, 40).replace(/[^\x20-\x7e]/gu, c => `\\u{${c.codePointAt(0).toString(16)}}`);

// Paste-ready StreamElements command replies, one per action. $(1|-) not $(1): with no argument, a bare
// $(queryescape $(1)) makes StreamElements drop the whole command silently (seen with a bare !fight and !strike).
// !give also sends its second word, the amount, as a=.
export function seCommandLines(origin, channel, key, names = {}) {
  return SE_ACTIONS.map(action => {
    const url = `${origin}/api/se/${channel}/${action}?k=${key}&id=$(sender.twitchid)&u=$(sender.name)&d=$(queryescape $(sender))&t=$(queryescape $(1|-))&m=$(msgid)${action === 'give' ? '&a=$(queryescape $(2|-))' : ''}`;
    return { action, name: names[action] || DEFAULT_SE_NAMES[action], response: `$(customapi ${url})` };
  });
}

// !give's amount: a whole number of dollars ("20" or "$20"), or null.
export function seAmount(raw) {
  const m = /^\$?(\d{1,7})$/.exec(String(raw ?? '').replace(/[\u{E0000}-\u{E007F}\u034F\u180E\u200B-\u200D\u2060\uFEFF\s]/gu, ''));
  return m ? Number(m[1]) : null;
}

// SE command → the chat text the game parser understands.
export function seCommandText(action, target) {
  const verb = action === 'challenge' ? 'duel' : action;
  return target ? `!${verb} @${target}` : `!${verb}`;
}

const secs = ms => Math.max(1, Math.ceil(ms / 1000));
const short = s => String(s || '').slice(0, 25);
// Channel links name the channel so viewers land in the right room.
// Always names the channel: /play/ asks which stream the viewer watches.
const siteLink = (origin, channel, hash = '') => origin ? `${origin}/${channel ? '?channel=' + channel : ''}${hash}` : '';
const gearUp = (origin, channel, lead = 'Gear up at') => { const link = siteLink(origin, channel); return link ? ` ${lead} ${link}` : ''; };
const noFighter = (who, self, origin, channel) => self ? `@${who}, you have no fighter in the arena yet!${gearUp(origin, channel)}` : `@${who} has no fighter in the arena yet!${gearUp(origin, channel, 'Send them to')}`;

// !fray: how to join, with this channel's own command names.
export function seHelpText({ names = {}, origin = '', channel = '' } = {}) {
  const n = a => names[a] || DEFAULT_SE_NAMES[a];
  const link = siteLink(origin, channel);
  return `PixFray duels: gear up${link ? ' at ' + link : ' on the PixFray site'}, then name your rival with ${n('challenge')} @name. They answer ${n('accept')}. Again? ${n('rematch')}. More: ${n('checkin')} ${n('wallet')} ${n('top')} ${n('look')}`;
}

// The bot's timed reminder (config.reminderMin): the !fray line, which already lists the other commands.
export function seReminderText({ names = {}, origin = '', channel = '' } = {}) {
  return seHelpText({ names, origin, channel });
}

// The bot's line when a challenge runs out unanswered (StreamElements can't post on its own, so only the bot says it).
export function seExpiredText({ a = 'someone', b = 'someone', timeoutMs = 30000, names = {} } = {}) {
  const n = x => names[x] || DEFAULT_SE_NAMES[x];
  return `Challenge expired: @${b} didn't answer ${a} within ${secs(timeoutMs)} s. ${a}, try again with ${n('challenge')} @${b}`;
}

// The bot's line once the stream has played a duel (duel.revealAt): who won, how, and both Elo changes. Never earlier, so
// chat doesn't spoil the stream. On a bot channel this line is the winner announcement (the overlay shows no banner).
// Why a duel counted for nothing (server/game.js beginDuel).
const UNRATED_TEXT = { new_account: 'a Twitch account under 7 days old', pair_cap: `${PAIR_RATED_PER_DAY} ranked duels between them in 24 h already` };
export const unratedText = reason => UNRATED_TEXT[reason] ? `Just for fun (${UNRATED_TEXT[reason]}): no Elo or dollars.` : '';

export function seResultText({ winner = 'someone', loser = 'someone', w = {}, l = {}, decision = 'ko', flawless = false, unrated = '' } = {}) {
  const d = x => (x < 0 ? '-' : '+') + Math.abs(Number(x) || 0);
  const how = (decision === 'hp' ? ' on HP' : decision === 'sudden_death' ? ' in sudden death' : '') + (flawless ? ', flawless' : '');
  if (unrated) return `${winner} beat ${loser}${how}! ${unratedText(unrated)}`;
  return `${winner} beat ${loser}${how}! ${winner} ${w.after} Elo (${d(w.delta)}), ${loser} ${l.after} Elo (${d(l.delta)}).`;
}

// A channel on the PixFray bot has no StreamElements in the way, so its give command is !give (unless mods renamed it).
export const botNames = names => ({ ...names, give: !names.give || names.give === '!pay' ? '!give' : names.give });

// !look: a link straight to the Fighter tab, where the sender picks or changes their fighter.
export function seLookText({ who = '', hasFighter = false, origin = '', channel = '' } = {}) {
  const link = siteLink(origin, channel, '#fighter');
  return `@${short(who)}, ${hasFighter ? 'change your look' : 'pick your fighter'}${link ? ' here: ' + link : ' on the PixFray site'}`;
}

// !top: the first five of the leaderboard (rows in leaderboard order) on one line.
export function seTopText(rows, { origin = '', channel = '' } = {}) {
  const link = siteLink(origin, channel, '#ranks');
  if (!rows.length) return `The arena has no champions yet!${gearUp(origin, channel)} and win a duel.`;
  const line = `Top ${Math.min(5, rows.length)}: ` + rows.slice(0, 5).map((r, i) => `${i + 1}. ${short(r.displayName || r.username)} ${r.elo}`).join(' · ') + '.';
  return link && line.length + link.length < MAX_REPLY - 12 ? `${line} Full list: ${link}` : line;
}

// !elo [@name]: one fighter's rating and place. `found` = { profile, rank, total } or null.
export function seEloText(found, { self, askerName = '', target = '', origin = '', channel = '' } = {}) {
  if (!found) {
    return self ? noFighter(short(askerName) || 'you', true, origin, channel) : noFighter(target, false, origin, channel);
  }
  const { profile: p, rank, total } = found;
  return `${short(p.displayName || p.username)}: ${p.elo} Elo, rank ${rank} of ${total}, ${p.wins} win${p.wins === 1 ? '' : 's'} and ${p.losses} loss${p.losses === 1 ? '' : 'es'}.`;
}
// !checkin: one line per outcome of ChannelRoom.checkin (server/channel.js).
export function seCheckinText(r, { who = '', origin = '', channel = '', maxPoints = 20 } = {}) {
  const me = short(who) || 'you';
  switch (r?.reason) {
    case 'checked_in': {
      const extras = [`${r.streak}-stream streak`, r.milestone ? 'streak bonus' : '', r.freeMiss ? 'free miss used' : ''].filter(Boolean).join(', ');
      const gain = r.points ? `+${r.points} upgrade point${r.points === 1 ? '' : 's'} (${extras})` : `${extras}`;
      const link = siteLink(origin, channel, '#upgrades');
      const total = r.total >= maxPoints ? `${maxPoints} of ${maxPoints} points, the most a fighter can hold.` : `${r.total} of ${maxPoints} points.`;
      if (r.test) return `[Test, not saved] @${me} would check in: ${gain}. ${total}`;
      return `@${me} checked in: ${gain}. ${total}${r.points && link ? ' Spend them at ' + link : ''}`;
    }
    case 'already_checked_in': return `@${me}, you already checked in this stream (${r.streak}-stream streak). Come back next stream!`;
    case 'not_live': return `Check-ins open while ${channel || 'the stream'} is live. See you next stream!`;
    case 'no_fighter': return noFighter(me, true, origin, channel);
    default: return "Couldn't reach Twitch to check the stream. Try again in a minute!";
  }
}
// !wallet: dollars, upgrade points and streak. w = ChannelRoom.wallet() or null (no fighter).
export function seWalletText(w, { who = '', origin = '', channel = '', maxPoints = 20 } = {}) {
  const me = short(who) || 'you';
  if (!w) return noFighter(me, true, origin, channel);
  return `@${me}: $${w.dollars} PixFray dollars, ${w.points} of ${maxPoints} upgrade points, ${w.streak}-stream streak.`;
}

// !pet [@name]: p = ChannelRoom.petInfo() -> { name, pet: {label, tier, boost} | null }, or null (no fighter).
export function sePetText(p, { who = '', target = '', origin = '', channel = '' } = {}) {
  const me = short(who) || 'you';
  if (!p) return target ? noFighter(target, false, origin, channel) : noFighter(me, true, origin, channel);
  if (!p.pet) {
    if (target) return `@${short(p.name)} has no pet yet.`;
    const link = siteLink(origin, channel, '#pets');
    return `@${me}, you have no pet yet. Buy one with PixFray dollars${link ? ' at ' + link : ' on the PixFray site.'}`;
  }
  return `@${target ? short(p.name) : me}'s pet: ${p.pet.label} (${p.pet.tier}), ${boostText(p.pet.boost)}.`;
}

// !give @name amount: one line per outcome of ChannelRoom.give (server/channel.js).
export function seGiveText(r, { who = '', target = '', origin = '', channel = '', names = {} } = {}) {
  const me = short(who) || 'you', n = a => names[a] || DEFAULT_SE_NAMES[a];
  switch (r?.reason) {
    case 'given': return `@${me} gave $${r.amount} to @${short(r.to)}. You have $${r.dollars} left.`;
    case 'give_off': return 'Giving dollars is off on this channel.';
    case 'no_fighter': return noFighter(me, true, origin, channel);
    case 'give_usage': return `Give who, and how much? Type ${n('give')} @name 10`;
    case 'target_not_found': return noFighter(target, false, origin, channel);
    case 'self_give': return `@${me}, you can't give dollars to yourself!`;
    case 'not_live': return `Giving opens while ${channel || 'the stream'} is live. See you next stream!`;
    case 'too_few_duels': return `@${me}, finish ${r.need} duels before giving dollars. You have ${r.duels} so far.`;
    case 'give_cap': return `@${me}, you gave the most for this stream ($${r.max}). Give more next stream!`;
    case 'over_cap': return `@${me}, you can give $${r.left} more this stream.`;
    case 'not_enough': return `@${me}, you only have $${r.dollars}.`;
    case 'target_full': return r.room > 0 ? `@${short(r.to)} can hold only $${r.room} more.` : `@${short(r.to)} already holds the most dollars a fighter can.`;
    default: return "Couldn't reach Twitch to check the stream. Try again in a minute!";
  }
}
const nameOf = (state, id) => { const p = state.players.find(x => x.userId === id); return p?.displayName || p?.username || 'someone'; };

// One short chat line for the bot to post, built from the reducer result and the state after it.
// actorRegistered: whether the sender has a saved fighter, so a sign-in refusal can say who is missing one.
export function seReplyText({ result, state, actorId, action, target, names = {}, origin, now = Date.now(), actorRegistered = true }) {
  const n = a => names[a] || DEFAULT_SE_NAMES[a];
  const me = nameOf(state, actorId);
  const reason = result?.reason || '';
  if (result?.ok) {
    const duel = state.duels.find(d => d.id === result.duelId);
    const other = duel ? (duel.a === actorId ? duel.b : duel.a) : '';
    if (reason === 'quick_duel') {
      // No result here: chat is ahead of the stream, so the overlay shows the winner first. Challenger first,
      // never winner first, so the order gives nothing away.
      const [a, b] = duel ? [duel.a, duel.b] : [actorId, other];
      return `Fight on: ${nameOf(state, a)} vs ${nameOf(state, b)}! Watch the stream for the winner.` + (duel?.unrated ? ' ' + unratedText(duel.unrated) : '');
    }
    if (!duel) return MISSED_TEXT;   // ok but no duel = the text didn't parse as a command
    if (action === 'accept' || reason === 'duel_started') return `Duel on: ${nameOf(state, duel?.a)} vs ${nameOf(state, duel?.b)}!`;
    if (action === 'rematch') { const o = nameOf(state, other); return `${me} wants a rematch with @${o}! @${o}, type ${n('rematch')} or ${n('accept')} to fight, or ${n('decline')} to back out within ${secs(state.config.challengeTimeoutMs || 30000)} s.`; }
    if (action === 'challenge') return `${me} challenges @${target}! @${target}, type ${n('accept')} to fight or ${n('decline')} to back out within ${secs(state.config.challengeTimeoutMs || 30000)} s.`;
    if (reason === 'challenge_declined') return `${me} backs out of the duel.`;
    if (reason === 'duel_completed') {
      const w = state.players.find(p => p.userId === actorId), l = state.players.find(p => p.userId === other);
      return `${me} knocked out ${nameOf(state, other)} and wins.` + (w && l ? ` Elo: ${me} ${w.elo}, ${nameOf(state, other)} ${l.elo}.` : '');
    }
    if (reason === 'action_applied') {
      if (result.ability === 'heal') return `${me} heals ${result.amount} HP (${duel?.hp?.[actorId] ?? '?'} HP).`;
      return `${me} hits ${nameOf(state, other)} for ${result.amount} (${nameOf(state, other)} ${duel?.hp?.[other] ?? '?'} HP).`;
    }
    return `${me}: done.`;
  }
  // Every channel has its own profiles, so the link must name it.
  const ch = state.channel;
  switch (reason) {
    case 'chat_offline': case 'duels_disabled': return 'The arena is closed right now. Come back soon!';
    case 'ranked_sign_in_required':
      if (!actorRegistered) return noFighter(me, true, origin, ch);
      return target ? noFighter(target, false, origin, ch) : `Your rival has no fighter in the arena yet!${gearUp(origin, ch, 'Send them to')}`;
    case 'target_required': return `Challenge who? Name your rival: ${n('challenge')} @name`;
    case 'target_not_found': return noFighter(target, false, origin, ch);
    case 'self_duel': return `${me}, you can't fight your own shadow! Name a rival: ${n('challenge')} @name`;
    case 'player_busy': return 'One of you is already fighting! Wait for the bell, then try again.';
    case 'result_hidden': return 'That fight is still playing on stream. Give it a few seconds!';
    case 'respawning': {
      const down = result.userId || actorId;
      // The loser of a quick duel is down before the stream has shown the fight, so don't name them yet.
      if (hiddenResults(state, now).has(down)) return 'That fight is still playing on stream. Give it a few seconds!';
      return `${nameOf(state, down)} is still seeing stars. Give it a few seconds!`;
    }
    case 'channel_full': return 'Every ring is taken! Try again in a moment.';
    case 'rematch_cooldown': return `Rematch in ${secs((result.retryAt || now) - now)} s! Catch your breath first.`;
    case 'no_previous_opponent': return `${me}, you have nobody to rematch yet. Start one: ${n('challenge')} @name`;
    case 'challenge_not_found': return `${me}, nobody has challenged you yet. Start one: ${n('challenge')} @name`;
    case 'not_in_active_duel': case 'not_in_duel': return `${me}, you're not in a fight. Start one: ${n('challenge')} @name`;
    case 'wrong_opponent': return `${me}, that's not your rival!`;
    case 'duplicate': return '';
    case 'active_player_cap': return 'The arena is packed! Try again soon.';
    default: return MISSED_TEXT;   // the reason code stays in the command log
  }
}
