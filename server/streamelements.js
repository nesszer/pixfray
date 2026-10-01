// StreamElements chat source. Each game action is a StreamElements custom command whose reply is
// $(customapi <url>): the bot GETs /api/se/<channel>/<action>?k=..&id=..&u=..&d=..&t=..&m=.. and posts our reply.
// The trigger word lives only in StreamElements, so commands can be renamed there freely.
export const SE_PATH = /^\/api\/se\/([a-z0-9_]{1,25})\/([a-z]{1,16})$/;
export const SE_SUBSCRIPTION_ID = 'se-streamelements';   // marks StreamElements as the chat source in state.chat
export const SE_ACTIONS = ['challenge', 'accept', 'decline'];   // quick duels need no attack commands
export const DEFAULT_SE_NAMES = { challenge: '!challenge', accept: '!fight', decline: '!decline' };
const MAX_REPLY = 380;   // StreamElements cuts responses at 400 bytes

const reply = (body, status = 200) => new Response(String(body).slice(0, MAX_REPLY), { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// GET /api/se/<channel>/<action>. The per-channel key is the authentication; the room checks it.
export async function handleStreamElements(request, env, { url, origin, channels, roomFetch }) {
  if (request.method !== 'GET') return reply('Use GET', 405);
  const m = SE_PATH.exec(url.pathname);
  if (!m) return reply('Unknown command', 404);
  const [, channel, action] = m;
  if (!channels.includes(channel)) return reply('Mini Chat is not enabled for this channel', 404);
  if (!SE_ACTIONS.includes(action)) return reply('Mini Chat: attack commands are gone. Duels are !challenge @name, then !fight.');   // old !attack/!strike/!heavy/!heal
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
  return reply(data.reply || 'Mini Chat: something went wrong');   // always 200 so the bot shows the text
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
const nameOf = (state, id) => { const p = state.players.find(x => x.userId === id); return p?.displayName || p?.username || 'someone'; };

// One short chat line for the bot to post, built from the reducer result and the state after it.
export function seReplyText({ result, state, actorId, action, target, names = {}, origin, now = Date.now() }) {
  const n = a => names[a] || DEFAULT_SE_NAMES[a];
  const me = nameOf(state, actorId);
  const reason = result?.reason || '';
  if (result?.ok) {
    const duel = state.duels.find(d => d.id === result.duelId);
    const other = duel ? (duel.a === actorId ? duel.b : duel.a) : '';
    if (reason === 'quick_duel') {
      const w = state.players.find(p => p.userId === result.winnerId), l = state.players.find(p => p.userId === result.loserId);
      const said = { hit: 'hit lands', counter: 'countered', miss: 'miss' };
      const swings = (result.swings || []).map(s => `${nameOf(state, s.attackerId)} rolls ${s.die}: ${said[s.outcome]}.`).join(' ');
      const end = ` ${nameOf(state, result.winnerId)} knocks out ${nameOf(state, result.loserId)}!` + (w && l ? ` Elo: ${nameOf(state, result.winnerId)} ${w.elo}, ${nameOf(state, result.loserId)} ${l.elo}.` : '');
      return (swings.length > 220 ? swings.slice(0, 217) + '...' : swings) + end;
    }
    if (!duel) return `Mini Chat: couldn't read that command, try again.`;   // ok but no duel = the text didn't parse as a command
    if (action === 'accept' || reason === 'duel_started') return `Duel on: ${nameOf(state, duel?.a)} vs ${nameOf(state, duel?.b)}.`;
    if (action === 'challenge') return `${me} challenges @${target} to a duel. @${target}, type ${n('accept')} (or ${n('challenge')} @${me}) or ${n('decline')} within ${secs(state.config.challengeTimeoutMs || 30000)} s.`;
    if (reason === 'challenge_declined') return `${me} declined the duel.`;
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
  const signUp = origin ? ` Save a fighter at ${origin}` : '';
  switch (reason) {
    case 'chat_offline': return 'Mini Chat: duels are paused, StreamElements is not connected in the admin page.';
    case 'duels_disabled': return 'Mini Chat: duels are turned off right now.';
    case 'ranked_sign_in_required': return action === 'challenge' || action === 'accept' ? `Mini Chat: both players need a saved fighter first.${signUp}` : `${me}, save a fighter first.${signUp}`;
    case 'target_required': return `Mini Chat: who? Use ${n('challenge')} @name`;
    case 'target_not_found': return `Mini Chat: @${target} needs to save a fighter first.${signUp}`;
    case 'self_duel': return `${me}, you can't duel yourself.`;
    case 'player_busy': return `Mini Chat: one of you is already in a duel.`;
    case 'respawning': return `${me} is still knocked out.`;
    case 'channel_full': return 'Mini Chat: all duel slots are taken, try again soon.';
    case 'rematch_cooldown': return `Mini Chat: rematch available in ${secs((result.retryAt || now) - now)} s.`;
    case 'challenge_not_found': return `${me}, you have no pending challenge.`;
    case 'not_in_active_duel': case 'not_in_duel': return `${me}, you're not in a duel. Use ${n('challenge')} @name`;
    case 'wrong_opponent': return `${me}, that's not your opponent.`;
    case 'duplicate': return '';
    case 'active_player_cap': return 'Mini Chat: the arena is full.';
    default: return `Mini Chat: couldn't do that (${reason || 'error'}).`;
  }
}
