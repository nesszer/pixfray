// StreamElements chat source. Each game action is a StreamElements custom command whose reply is
// $(customapi <url>): the bot GETs /api/se/<channel>/<action>?k=..&id=..&u=..&d=..&t=..&m=.. and posts our reply.
// The trigger word lives only in StreamElements, so commands can be renamed there freely.
export const SE_PATH = /^\/api\/se\/([a-z0-9_]{1,25})\/([a-z]{1,16})$/;
export const SE_SUBSCRIPTION_ID = 'se-streamelements';   // marks StreamElements as the chat source in state.chat
export const SE_ACTIONS = ['challenge', 'accept', 'decline', 'top', 'elo', 'help'];   // quick duels need no attack commands
export const SE_READ_ACTIONS = ['top', 'elo', 'help'];   // no game state, so they work while duels are paused
// StreamElements has a built-in !top that can't be edited, so the leaderboard command is !ranks.
export const DEFAULT_SE_NAMES = { challenge: '!challenge', accept: '!fight', decline: '!decline', top: '!ranks', elo: '!elo', help: '!minichat' };
export const LOST_TEXT = 'Lost in the arena? Type !minichat';
export const MISSED_TEXT = "That move didn't land. Try again in a moment!";
export const OFF_TEXT = 'Mini Chat is off on this channel right now.';
const MAX_REPLY = 380;   // StreamElements cuts responses at 400 bytes

const reply = (body, status = 200) => new Response(String(body).slice(0, MAX_REPLY), { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// GET /api/se/<channel>/<action>. The per-channel key is the authentication; the room checks it.
// channelState(channel) -> 'builtin' | 'on' | 'paused' | null (server/channels.js); tests may pass a channels list.
export async function handleStreamElements(request, env, { url, origin, channels = [], channelState, roomFetch, dropSubscription }) {
  if (request.method !== 'GET') return reply('Use GET', 405);
  const m = SE_PATH.exec(url.pathname);
  if (!m) return reply('Unknown command', 404);
  const [, channel, action] = m;
  const state = channelState ? await channelState(channel) : channels.includes(channel) ? 'builtin' : null;
  if (state === 'paused') return reply(OFF_TEXT);
  if (state !== 'builtin' && state !== 'on') return reply('Mini Chat is not enabled for this channel', 404);
  if (!SE_ACTIONS.includes(action)) return reply(LOST_TEXT);   // e.g. an old !attack/!strike/!heavy/!heal
  const q = name => (url.searchParams.get(name) || '').trim();
  const key = q('k');
  if (!key || key.length > 128) return reply('Mini Chat: missing key. Copy the commands again from the admin page.');
  const body = {
    key,
    action,
    userId: q('id').slice(0, 32),
    username: q('u').replace(/^@/, '').toLowerCase().slice(0, 25),
    displayName: q('d').slice(0, 48),
    target: seTarget(q('t')),
    targetRaw: shown(q('t')),   // for the command log
    messageId: q('m').slice(0, 64),
  };
  const r = await roomFetch(channel, '/se?origin=' + encodeURIComponent(origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (data.switchedFrom && dropSubscription) dropSubscription(data.switchedFrom);
  // always 200 so the bot shows the text; '' (a repeated message id) means post nothing
  return reply(typeof data.reply === 'string' ? data.reply : MISSED_TEXT);
}

// $(1) as sent by StreamElements -> a Twitch login, or '' for none. '-' means no argument; chat clients
// append invisible characters (U+E0000, U+034F) to repeated messages; those are stripped first.
export function seTarget(raw) {
  const m = /^@?([a-z0-9_]{1,25})$/i.exec(String(raw || '').replace(/[\u{E0000}-\u{E007F}\u034F\u180E\u200B-\u200D\u2060\uFEFF\s]/gu, ''));
  return m ? m[1].toLowerCase() : '';
}

// Text with invisible and non-ASCII characters written as \u{...}, for logs.
export const shown = raw => String(raw || '').slice(0, 40).replace(/[^\x20-\x7e]/gu, c => `\\u{${c.codePointAt(0).toString(16)}}`);

// Paste-ready StreamElements command replies, one per action. $(1|-) not $(1): with no argument, a bare
// $(queryescape $(1)) makes StreamElements drop the whole command silently (seen with a bare !fight and !strike).
export function seCommandLines(origin, channel, key, names = {}) {
  return SE_ACTIONS.map(action => {
    const url = `${origin}/api/se/${channel}/${action}?k=${key}&id=$(sender.twitchid)&u=$(sender.name)&d=$(queryescape $(sender))&t=$(queryescape $(1|-))&m=$(msgid)`;
    return { action, name: names[action] || DEFAULT_SE_NAMES[action], response: `$(customapi ${url})` };
  });
}

// SE command → the chat text the game parser understands.
export function seCommandText(action, target) {
  const verb = action === 'challenge' ? 'duel' : action;
  return target ? `!${verb} @${target}` : `!${verb}`;
}

const secs = ms => Math.max(1, Math.ceil(ms / 1000));
const short = s => String(s || '').slice(0, 25);
// The site link for a channel: every channel but nesszerra names itself.
const siteLink = (origin, channel, hash = '') => origin ? `${origin}/${channel && channel !== 'nesszerra' ? '?channel=' + channel : ''}${hash}` : '';
const gearUp = (origin, channel, lead = 'Gear up at') => { const link = siteLink(origin, channel); return link ? ` ${lead} ${link}` : ''; };
const noFighter = (who, self, origin, channel) => self ? `@${who}, you have no fighter in the arena yet!${gearUp(origin, channel)}` : `@${who} has no fighter in the arena yet!${gearUp(origin, channel, 'Send them to')}`;

// !minichat: how to join, with this channel's own command names.
export function seHelpText({ names = {}, origin = '', channel = '' } = {}) {
  const n = a => names[a] || DEFAULT_SE_NAMES[a];
  const link = siteLink(origin, channel);
  return `Mini Chat duels: gear up${link ? ' at ' + link : ' on the Mini Chat site'}, then name your rival with ${n('challenge')} @name. They answer ${n('accept')}.`;
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
      const w = state.players.find(p => p.userId === result.winnerId), l = state.players.find(p => p.userId === result.loserId);
      // One line; the overlay plays the rolls. "A beats B in 4 rolls (66 HP left). Elo: A 1012, B 988."
      const n = (result.swings || []).length, wn = nameOf(state, result.winnerId), ln = nameOf(state, result.loserId);
      const how = result.decision === 'hp' ? ` on HP after ${n} rolls` : ` in ${n} roll${n === 1 ? '' : 's'}` + (result.decision === 'sudden_death' ? ' (sudden death)' : '');
      const left = ` (${result.winnerHp} HP left${result.flawless ? ', flawless, +3 bonus' : ''})`;
      return `${wn} beats ${ln}${how}${left}.` + (w && l ? ` Elo: ${wn} ${w.elo}, ${ln} ${l.elo}.` : '');
    }
    if (!duel) return MISSED_TEXT;   // ok but no duel = the text didn't parse as a command
    if (action === 'accept' || reason === 'duel_started') return `Duel on: ${nameOf(state, duel?.a)} vs ${nameOf(state, duel?.b)}!`;
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
  // Every channel but nesszerra has its own profiles, so the link must name the channel.
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
    case 'respawning': return `${me} is still seeing stars. Give it a few seconds!`;
    case 'channel_full': return 'Every ring is taken! Try again in a moment.';
    case 'rematch_cooldown': return `Rematch in ${secs((result.retryAt || now) - now)} s! Catch your breath first.`;
    case 'challenge_not_found': return `${me}, nobody has challenged you yet. Start one: ${n('challenge')} @name`;
    case 'not_in_active_duel': case 'not_in_duel': return `${me}, you're not in a fight. Start one: ${n('challenge')} @name`;
    case 'wrong_opponent': return `${me}, that's not your rival!`;
    case 'duplicate': return '';
    case 'active_player_cap': return 'The arena is packed! Try again soon.';
    default: return MISSED_TEXT;   // the reason code stays in the command log
  }
}
