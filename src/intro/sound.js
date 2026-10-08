// Synthesized sound for the intro: a low fire-lit drone with crackle, and short pixel blips for events.
// Nothing plays until the visitor turns sound on (browsers need a click first). No audio files.
export function createSound() {
  let ctx = null,
    master = null,
    on = false;

  function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // drone: two detuned triangles under a slow-moving low-pass
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380;
    lp.Q.value = 3;
    lp.connect(master);
    const lfo = ctx.createOscillator(),
      lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    for (const [f, g] of [
      [55, 0.05],
      [82.6, 0.035],
      [110.3, 0.012],
    ]) {
      const o = ctx.createOscillator(),
        v = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      v.gain.value = g;
      o.connect(v).connect(lp);
      o.start();
    }
    // crackle: sparse noise ticks through a band-pass, like a lantern flame
    const len = ctx.sampleRate * 2,
      buf = ctx.createBuffer(1, len, ctx.sampleRate),
      d = buf.getChannelData(0);
    for (let i = 0; i < len; i++)
      d[i] = Math.random() < 0.0009 ? (Math.random() * 2 - 1) * (0.4 + Math.random()) : (Math.random() * 2 - 1) * 0.012;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2200;
    bp.Q.value = 0.8;
    const cg = ctx.createGain();
    cg.gain.value = 0.35;
    src.connect(bp).connect(cg).connect(master);
    src.start();
  }

  function setOn(value) {
    on = value;
    if (on && !ctx) start();
    if (!ctx) return;
    if (on) ctx.resume();
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.25);
  }

  // A short square-wave note, optionally sliding to another pitch.
  function blip(freq = 660, { to = freq, dur = 0.09, type = "square", gain = 0.05, delay = 0 } = {}) {
    if (!on || !ctx) return;
    const t = ctx.currentTime + delay,
      o = ctx.createOscillator(),
      g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  return {
    get on() {
      return on;
    },
    setOn,
    chapter(i) {
      blip(392 * Math.pow(2, (i / 12) * 2), { dur: 0.12, type: "triangle", gain: 0.06 });
      blip(784 * Math.pow(2, (i / 12) * 2), { dur: 0.08, type: "triangle", gain: 0.03, delay: 0.07 });
    },
    roll() {
      for (let i = 0; i < 6; i++)
        blip(1400 + Math.random() * 600, { to: 900, dur: 0.025, gain: 0.025, delay: i * 0.055 });
    },
    hit(crit) {
      blip(crit ? 330 : 260, { to: 70, dur: crit ? 0.32 : 0.2, gain: 0.07 });
      if (crit) blip(990, { to: 1320, dur: 0.12, type: "triangle", gain: 0.04, delay: 0.05 });
    },
    miss() {
      blip(520, { to: 480, dur: 0.06, type: "triangle", gain: 0.03 });
    },
    jump() {
      blip(330, { to: 880, dur: 0.14, gain: 0.05 });
    },
    coin() {
      blip(988, { dur: 0.06, gain: 0.03 });
      blip(1319, { dur: 0.12, gain: 0.03, delay: 0.06 });
    },
  };
}
