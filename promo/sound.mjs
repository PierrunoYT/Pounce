// Procedural soundtrack for the launch video: a soft music bed plus UI sound effects at the
// animation's cue times (see audioCues() in launch.html). No samples, no npm packages.
export const RATE = 48000;

const BEAT = 0.5; // 120 BPM
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

// [start time, chord notes, bass note]
const CHORDS = [
  [0, [53, 57, 60, 64], 41], // Fmaj7
  [2, [55, 59, 62, 64], 43], // G6
  [4, [52, 55, 59, 62], 40], // Em7
  [6, [57, 60, 64, 67], 45], // Am7
  [8, [53, 57, 60, 64], 41], // Fmaj7
  [10, [55, 59, 62, 64], 43], // G6
  [12.75, [60, 64, 67, 71, 74], 36], // Cmaj9 for the outro
];
const GROOVE = [3.0, 12.5]; // beat and arpeggio play while the app and stats are on screen

export function synthesize(cues, duration) {
  const n = Math.ceil(duration * RATE);
  const bus = () => [new Float32Array(n), new Float32Array(n)];
  const dry = bus();
  const send = bus(); // goes through the reverb

  music(dry, send, duration);
  const rng = seeded(7);
  for (const c of cues) effect(dry, send, c, rng);

  const wet = reverb(send);
  const out = bus();
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < n; i++) out[ch][i] = dry[ch][i] + send[ch][i] * 0.6 + wet[ch][i] * 0.35;
  }
  master(out, duration);
  return out;
}

// ---------- music ----------
function music(dry, send, duration) {
  CHORDS.forEach(([start, notes, bass], k) => {
    const end = k + 1 < CHORDS.length ? CHORDS[k + 1][0] : duration;
    for (const m of notes) {
      // Two slightly detuned copies, one per side, for a wide pad.
      voice(dry, start, end - start + 1.2, (t) => pad(t, midi(m) * 1.0025, end - start), 0.022, -0.6);
      voice(dry, start, end - start + 1.2, (t) => pad(t, midi(m) * 0.9975, end - start), 0.022, 0.6);
    }
    const from = Math.max(start, GROOVE[0]); // bass enters with the groove
    if (from < end) voice(dry, from, end - from + 0.4, (t) => bassTone(t, midi(bass), end - from), 0.16, 0);
  });

  // Eighth-note arpeggio over the current chord.
  const pattern = [0, 1, 2, 3, 2, 1, 2, 3];
  for (let i = 0, t = GROOVE[0]; t < GROOVE[1]; i++, t = GROOVE[0] + i * BEAT / 2) {
    const notes = chordAt(t);
    const m = notes[pattern[i % pattern.length] % notes.length] + 12;
    const g = i % 2 === 0 ? 0.05 : 0.035;
    voice(dry, t, 0.7, (x) => pluck(x, midi(m)), g, i % 2 ? 0.35 : -0.35);
    voice(send, t, 0.7, (x) => pluck(x, midi(m)), g * 0.8, i % 2 ? 0.35 : -0.35);
  }

  // Soft kick on the beat, a whisper of hi-hat on the off-beat.
  const hatNoise = seeded(99);
  for (let t = GROOVE[0]; t < GROOVE[1]; t += BEAT) {
    voice(dry, t, 0.35, kick, 0.32, 0);
    const hp = highpass(0.85);
    voice(dry, t + BEAT / 2, 0.08, (x) => hp(hatNoise() * 2 - 1) * Math.exp(-x * 70), 0.05, 0.2);
  }
}

function chordAt(t) {
  let notes = CHORDS[0][1];
  for (const [start, n] of CHORDS) if (t >= start) notes = n;
  return notes;
}

function pad(t, f, hold) {
  const env = Math.min(1, t / 0.6) * (t > hold ? Math.max(0, 1 - (t - hold) / 1.2) : 1);
  const trem = 1 + 0.08 * Math.sin(TAU * 0.25 * t);
  return env * trem * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t) + 0.1 * Math.sin(TAU * 3 * f * t));
}

function bassTone(t, f, hold) {
  const env = Math.min(1, t / 0.05) * (t > hold ? Math.max(0, 1 - (t - hold) / 0.4) : 1);
  return env * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t));
}

function pluck(t, f) {
  const env = Math.exp(-t * 7) * Math.min(1, t * 400);
  return env * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 6));
}

function kick(t) {
  const k = 32;
  const phase = TAU * (48 * t + ((130 - 48) / k) * (1 - Math.exp(-k * t)));
  return Math.sin(phase) * Math.exp(-t * 12) * Math.min(1, t * 1000);
}

// ---------- sound effects ----------
function effect(dry, send, c, rng) {
  switch (c.kind) {
    case "whoosh": return whoosh(dry, send, c.t, 0.7, 0.14, rng, true);
    case "swish": return whoosh(dry, send, c.t, 0.4, 0.07, rng, false);
    case "land": {
      voice(dry, c.t, 0.4, (t) => Math.sin(TAU * (70 * t + 4 * (1 - Math.exp(-t * 20)))) * Math.exp(-t * 10), 0.35, 0);
      voice(dry, c.t, 0.25, (t) => Math.sin(TAU * (500 * t - 250 * t * t)) * Math.exp(-t * 18), 0.12, 0);
      [84, 91].forEach((m, i) => voice(send, c.t + 0.06 + i * 0.07, 1, (t) => bell(t, midi(m)), 0.06, i ? 0.3 : -0.3));
      return;
    }
    case "key": {
      // A short, slightly varied mechanical click.
      const hp = highpass(0.6);
      const lp = lowpass(0.5);
      const g = 0.11 * (0.8 + 0.3 * rng());
      const f = 1800 + 900 * rng();
      const pan = (rng() - 0.5) * 0.4;
      voice(dry, c.t, 0.04, (t) => lp(hp(rng() * 2 - 1)) * Math.exp(-t * 180) + 0.4 * Math.sin(TAU * f * t) * Math.exp(-t * 400), g, pan);
      return;
    }
    case "results":
      [88, 95].forEach((m, i) => voice(send, c.t + i * 0.045, 0.8, (t) => bell(t, midi(m)), 0.055, i ? 0.25 : -0.25));
      voice(dry, c.t, 0.5, (t) => bell(t, midi(88)), 0.04, 0);
      return;
    case "select":
      voice(dry, c.t, 0.12, (t) => Math.sin(TAU * 1100 * t) * Math.exp(-t * 45), 0.07, 0.1);
      return;
    case "stat": {
      const m = [84, 88, 91][c.n] ?? 84;
      voice(dry, c.t, 0.6, (t) => pluck(t, midi(m)), 0.12, (c.n - 1) * 0.4);
      voice(send, c.t, 0.9, (t) => bell(t, midi(m + 12)), 0.04, (c.n - 1) * 0.4);
      return;
    }
    case "chime":
      voice(dry, c.t, 0.5, (t) => Math.sin(TAU * (55 * t + 3 * (1 - Math.exp(-t * 18)))) * Math.exp(-t * 7), 0.4, 0);
      [72, 76, 79, 83, 86].forEach((m, i) =>
        voice(send, c.t + i * 0.035, 1.8, (t) => bell(t, midi(m)), 0.05, (i - 2) * 0.25));
      return;
  }
}

function whoosh(dry, send, t0, dur, gain, rng, rising) {
  // Filtered noise whose brightness sweeps across the gesture.
  let y = 0;
  voice(dry, t0, dur, (t) => {
    const x = t / dur;
    const cutoff = rising ? 0.02 + 0.25 * x * x : 0.27 - 0.25 * x;
    y += cutoff * ((rng() * 2 - 1) - y);
    return y * Math.sin(Math.PI * x) * 3;
  }, gain, 0);
}

function bell(t, f) {
  const env = Math.exp(-t * 3.2) * Math.min(1, t * 600);
  return env * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2.76 * f * t) * Math.exp(-t * 5));
}

// ---------- plumbing ----------
function voice(bus, t0, dur, gen, gain, pan) {
  const gl = Math.cos(((pan + 1) * Math.PI) / 4) * gain;
  const gr = Math.sin(((pan + 1) * Math.PI) / 4) * gain;
  const start = Math.round(t0 * RATE);
  const len = Math.round(dur * RATE);
  const n = bus[0].length;
  for (let i = 0; i < len && start + i < n; i++) {
    if (start + i < 0) continue;
    const s = gen(i / RATE);
    bus[0][start + i] += s * gl;
    bus[1][start + i] += s * gr;
  }
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function lowpass(a) { let y = 0; return (x) => (y += a * (x - y)); }
function highpass(a) { let y = 0, px = 0; return (x) => { y = a * (y + x - px); px = x; return y; }; }

// Small Schroeder reverb: parallel damped combs into series allpasses, slightly offset per side.
function reverb(input) {
  return input.map((buf, ch) => {
    const n = buf.length;
    const out = new Float32Array(n);
    const spread = ch * 23;
    for (const ms of [29.7, 37.1, 41.1, 43.7]) {
      const d = Math.round((ms / 1000) * RATE) + spread;
      const line = new Float32Array(d);
      let idx = 0, damp = 0;
      for (let i = 0; i < n; i++) {
        const y = line[idx];
        damp = y * 0.6 + damp * 0.4;
        line[idx] = buf[i] + damp * 0.8;
        idx = (idx + 1) % d;
        out[i] += y * 0.25;
      }
    }
    for (const ms of [5.0, 1.7]) {
      const d = Math.round((ms / 1000) * RATE) + spread;
      const line = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const b = line[idx];
        const x = out[i];
        line[idx] = x + b * 0.7;
        out[i] = b - x * 0.7;
        idx = (idx + 1) % d;
      }
    }
    return out;
  });
}

function master(out, duration) {
  const n = out[0].length;
  const fadeOut = 0.9;
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const g = Math.min(1, t / 0.03) * Math.min(1, Math.max(0, (duration - t) / fadeOut));
      out[ch][i] = Math.tanh(out[ch][i] * 1.4) * g;
      peak = Math.max(peak, Math.abs(out[ch][i]));
    }
  }
  const norm = peak > 0 ? 0.89 / peak : 1; // about -1 dBFS
  for (const buf of out) for (let i = 0; i < n; i++) buf[i] *= norm;
}

export function wav(channels) {
  const n = channels[0].length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const v = Math.max(-1, Math.min(1, channels[ch][i]));
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 4 + ch * 2);
    }
  }
  return buf;
}
