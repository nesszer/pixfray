// The demo (?demo=1): made-up chat, and with arena=1 a local duel every few seconds. Nothing is saved.
import type { ArenaDuel, ArenaEvent, Rating } from "./parse.ts";
import { arenaEnabled, channel, debug, replays } from "./overlay-stage.ts";
import { ids } from "./overlay-sprites.ts";
import { duelQueues, queueArenaEvent } from "./overlay-duels.ts";
import { acceptArenaSnapshot, onMessage } from "./overlay-sync.ts";

// A local-only duel preview, shaped like real server snapshots and events; returns its timer.
export function setupDemoArena() {
  const demoProfiles = (
    [
      ["Ness", "toon-ranger", "#fb923c", "heavy", 1220],
      ["Sunny", "female", "#60a5fa", "strike", 1184],
      ["Mochi", "toon-robot", "#f472b6", "heal", 1108],
      ["Cloud", "soldier", "#a78bfa", "strike", 1060],
      ["Pixel", "alien-green", "#4ade80", "heavy", 1012],
      ["Bean", "adventurer", "#facc15", "strike", 980],
      ["Luna", "toon-scout", "#e879f9", "heal", 940],
      ["Sprout", "player", "#34d399", "strike", 900],
    ] satisfies [string, string, string, string, number][]
  ).map(([displayName, avatar, color, defaultAbility, elo], index) => ({
    userId: "demo-" + index,
    username: String(displayName).toLowerCase(),
    displayName,
    registered: true,
    avatar,
    color,
    defaultAbility,
    hp: 100,
    elo,
    wins: index % 4,
    losses: index % 3,
    lastSeen: Date.now(),
    respawnAt: 0,
    hat: ["crown", "cap", "halo", "tophat", "horns", "wizard", "beanie", "bandana"][index],
    pet: ["dragon", "fox", "cat", "", "owl", "slime", "phoenix", "frog"][index],
    petTier: ["legendary", "rare", "uncommon", "", "epic", "common", "legendary", "uncommon"][index],
    recolor: ["", "", "violet", "", "", "gold", "", ""][index],
    petColor: ["", "ocean", "", "", "", "", "", "crimson"][index],
    accessory: ["cape", "glasses", "", "shades", "", "scarf", "monocle", "bowtie"][index],
    trail: ["flames", "", "hearts", "", "sparkles", "", "notes", ""][index],
    winEffect: ["fireworks", "confetti", "banner", "confetti", "fireworks", "banner", "confetti", "banner"][index],
    taunt: ["gg", "easy", "next", "bow", "rematch", "nap", "luck", "chat"][index],
    title: ["legend", "champion", "lucky", "wall", "", "menace", "owl", "rookie"][index],
  }));
  let revision = 1,
    round = 0,
    seq = 0,
    duel: ArenaDuel | null = null,
    lastPair = "",
    nextAt = Date.now() + 1500;
  const snapshot = () =>
    acceptArenaSnapshot(
      {
        channel,
        revision: ++revision,
        paused: false,
        chat: { connected: true, lastSeen: Date.now(), status: "enabled" },
        config: { maxHp: 100 },
        players: demoProfiles,
        duels: duel ? [duel] : [],
        events: [],
      },
      { revision },
    );
  const event = (fields: ArenaEvent) => ({ id: "demo-" + revision + "-" + ++seq, at: Date.now(), ...fields });
  snapshot();
  if (debug) {
    // the demo label is for testing only; on stream the demo looks like the real overlay
    const badge = document.createElement("div");
    badge.id = "arena-mode";
    badge.textContent = "DEMO · local match · not saved";
    Object.assign(badge.style, {
      position: "fixed",
      top: "12px",
      right: "12px",
      zIndex: "2",
      padding: "7px 10px",
      borderRadius: "4px",
      color: "#fff",
      background: "rgba(12,16,25,.82)",
      font: "600 11px system-ui,sans-serif",
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
  }
  // The same rules as the server's quick duel (settleQuickDuel in server/game.ts): one d6 per swing, 6 crits for 50,
  // 5 hits for 34, 3-4 misses, 1-2 is countered for 34. After 12 rolls more HP wins, a tie goes to sudden death.
  // Like a real !fight, the whole duel arrives at once (settled snapshot plus events) and the overlay replays it.
  function quickDuel() {
    round++;
    let a, b;
    do {
      const pool = [...demoProfiles];
      // the pool holds 8 profiles, so both picks exist
      a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!;
      b = pool[Math.floor(Math.random() * pool.length)]!;
    } while ([a.userId, b.userId].sort().join() === lastPair);
    lastPair = [a.userId, b.userId].sort().join();
    const id = "demo-duel-" + round,
      hp = { [a.userId]: 100, [b.userId]: 100 };
    const events = [event({ type: "duel_started", duelId: id, a: a.userId, b: b.userId, round, hp: { ...hp } })];
    let attacker = a,
      defender = b,
      winner = null,
      loser = null,
      decision = "ko";
    for (let i = 0; !winner && i < 200; i++) {
      const suddenDeath = i >= 12;
      if (i === 12) {
        if (hp[a.userId] !== hp[b.userId]) {
          decision = "hp";
          // hp holds both fighters' ids
          [winner, loser] = hp[a.userId]! > hp[b.userId]! ? [a, b] : [b, a];
          break;
        }
        decision = "sudden_death";
      }
      const die = 1 + Math.floor(Math.random() * 6);
      const base = { type: "duel_action", duelId: id, die };
      if (die === 3 || die === 4) {
        events.push(
          event({
            ...base,
            userId: attacker.userId,
            targetId: defender.userId,
            ability: attacker.defaultAbility,
            amount: 0,
            hp: { ...hp },
            miss: true,
          }),
        );
      } else {
        const counter = die <= 2,
          dealer = counter ? defender : attacker,
          target = counter ? attacker : defender;
        // hp holds both fighters' ids
        const amount = suddenDeath ? hp[target.userId]! : Math.min(hp[target.userId]!, die === 6 ? 50 : 34);
        hp[target.userId]! -= amount;
        const finisher = hp[target.userId]! <= 0;
        events.push(
          event({
            ...base,
            userId: dealer.userId,
            targetId: target.userId,
            ability: dealer.defaultAbility,
            amount,
            hp: { ...hp },
            ...(counter ? { counter: true } : {}),
            ...(die === 6 ? { crit: true } : {}),
            ...(finisher ? { finisher: true } : {}),
          }),
        );
        if (finisher) {
          winner = dealer;
          loser = target;
        }
      }
      [attacker, defender] = [defender, attacker];
    }
    // sudden death ends the duel on the first blow that lands, long before 200 rolls, so winner and loser are set
    const won = winner!,
      lost = loser!;
    const flawless = hp[won.userId] === 100,
      expectedA = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400)),
      scoreA = won === a ? 1 : 0;
    const next = {
      [a.userId]: Math.round(a.elo + 24 * (scoreA - expectedA)),
      [b.userId]: Math.round(b.elo + 24 * (expectedA - scoreA)),
    };
    if (flawless) next[won.userId]! += 3; // next holds both fighters' ids
    const ratings: Record<string, Rating> = {};
    for (const f of [a, b]) {
      // next holds both fighters' ids
      ratings[f.userId] = { before: f.elo, after: next[f.userId]!, delta: next[f.userId]! - f.elo };
      f.elo = next[f.userId]!;
    }
    won.wins++;
    lost.losses++;
    for (const f of demoProfiles) f.respawnAt = 0;
    lost.respawnAt = Date.now() + 5000;
    const flags = { ...(flawless ? { flawless: true } : {}), ...(decision !== "ko" ? { decision } : {}) };
    duel = { id, a: a.userId, b: b.userId, status: "completed", round, winnerId: won.userId, hp, ratings, ...flags };
    duel.rules = { maxHp: 100 };
    events.push(
      event({
        type: "duel_completed",
        duelId: id,
        winnerId: won.userId,
        loserId: lost.userId,
        round,
        respawnAt: lost.respawnAt,
        hp: { ...hp },
        ratings,
        ...flags,
      }),
    );
    snapshot();
    events.forEach(queueArenaEvent);
  }
  // The next duel starts a few seconds after the last replay ends, once the knockout and the result have played.
  return setInterval(() => {
    if (duelQueues.size || replays.size) {
      nextAt = Date.now() + 3500;
      return;
    }
    if (Date.now() >= nextAt) quickDuel();
  }, 250);
}

// Made-up chat: every demo fighter says hello, then one of them says something every 1.8 s.
export function demoChat() {
  const names = ["Ness", "Sunny", "Mochi", "Cloud", "Pixel", "Bean", "Luna", "Sprout"];
  names.forEach((name, i) =>
    onMessage({ username: name, displayName: name, userId: arenaEnabled ? "demo-" + i : String(i), text: "Hello!" }),
  );
  const timer = setInterval(() => {
    const name = names[Math.floor(Math.random() * names.length)];
    const texts = [
      "Hi chat!",
      "!jump",
      "That was amazing",
      "!color #f9a8d4",
      ids.length ? "!avatar " + ids[Math.floor(Math.random() * ids.length)] : "Let’s go!",
    ];
    onMessage({ username: name, displayName: name, text: texts[Math.floor(Math.random() * texts.length)] });
  }, 1800);
  return { disconnect: () => clearInterval(timer) };
}
