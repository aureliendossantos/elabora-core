// Discreet sound effects, synthesised (no file, no network): running water, the wooden groan of
// the gates, the ratchet of the paddles, a soft chime when the boat arrives. The audio context is
// only created after the learner's first click in the frame, and never in tests.
export function createAudio(random) {
  let ac = null, master = null, water = null, waterGain = null, waterFilter = null, muted = false, failed = false;

  function ensure() {
    if (ac || failed) return !!ac;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) { failed = true; return false; }
      ac = new AC();
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.55;
      master.connect(ac.destination);
      // Running water: brown noise through a band-pass whose level follows the flow.
      const len = ac.sampleRate * 2;
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (random() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
      water = ac.createBufferSource(); water.buffer = buf; water.loop = true;
      waterFilter = ac.createBiquadFilter(); waterFilter.type = 'bandpass'; waterFilter.frequency.value = 700; waterFilter.Q.value = 0.6;
      waterGain = ac.createGain(); waterGain.gain.value = 0;
      water.connect(waterFilter).connect(waterGain).connect(master);
      water.start();
      return true;
    } catch { failed = true; ac = null; return false; }
  }
  function now() { return ac ? ac.currentTime : 0; }
  function tone(type, freq, start, dur, gain, endFreq) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, start);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.03, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(master); o.start(start); o.stop(start + dur + 0.05);
  }
  function noiseBurst(start, dur, gain, freq) {
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (random() * 2 - 1) * (1 - i / n);
    const s = ac.createBufferSource(); s.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
    const g = ac.createGain(); g.gain.value = gain;
    s.connect(f).connect(g).connect(master); s.start(start);
  }
  return {
    unlock() { if (ensure() && ac.state === 'suspended') ac.resume().catch(() => {}); },
    get muted() { return muted; },
    setMuted(m) {
      muted = !!m;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, now(), 0.05);
    },
    // Flow: 0 to 1, how much water is moving; splash: 0 to 1, how much falls freely.
    setFlow(flow, splash) {
      if (!ac) return;
      waterGain.gain.setTargetAtTime(Math.min(0.5, flow * 0.42), now(), 0.25);
      waterFilter.frequency.setTargetAtTime(520 + splash * 900, now(), 0.3);
    },
    gate(duration) {
      if (!ac || muted) return;
      const t = now();
      // A slow wooden groan, then the soft knock of the leaves meeting their stop.
      tone('sawtooth', 62, t, Math.min(1.6, duration * 0.7), 0.035, 48);
      tone('triangle', 96, t + 0.1, Math.min(1.2, duration * 0.5), 0.025, 84);
      noiseBurst(t + duration - 0.05, 0.12, 0.18, 180);
    },
    strain() {
      if (!ac || muted) return;
      const t = now();
      tone('sawtooth', 55, t, 0.5, 0.05, 50);
      tone('sawtooth', 58, t + 0.05, 0.45, 0.03, 52);
      noiseBurst(t, 0.18, 0.12, 140);
    },
    paddle(open) {
      if (!ac || muted) return;
      const t = now();
      for (let i = 0; i < 7; i++) noiseBurst(t + i * 0.11, 0.025, 0.22, open ? 2400 : 1900);
    },
    boat() {
      if (!ac || muted) return;
      const t = now();
      tone('triangle', 70, t, 1.1, 0.03, 74);
    },
    success() {
      if (!ac || muted) return;
      const t = now();
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => { tone('sine', f, t + i * 0.13, 0.9, 0.07); tone('triangle', f * 2, t + i * 0.13, 0.4, 0.012); });
      tone('sawtooth', 196, t + 0.75, 0.42, 0.03, 190);
      tone('sawtooth', 197.5, t + 0.75, 0.42, 0.025, 191);
    },
    dispose() { try { water?.stop(); ac?.close(); } catch { /* already closed */ } ac = null; }
  };
}
