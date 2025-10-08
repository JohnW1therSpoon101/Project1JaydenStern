// synth.js
export class Synth {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} destination - where this voice should ultimately connect
   * @param {{wave?: OscillatorType, cutoff?: number, q?: number, a?: number, d?: number, s?: number, r?: number}} [opts]
   */
  constructor(ctx, destination, opts = {}) {
    this.ctx = ctx;

    // Config (defaults; can be live-updated from main.js)
    this.wave = opts.wave ?? "sawtooth";
    this.cutoff = opts.cutoff ?? 2000; // Hz
    this.q = opts.q ?? 0.8;
    this.A = opts.a ?? 0.01; // attack seconds
    this.D = opts.d ?? 0.12; // decay seconds
    this.S = opts.s ?? 0.6; // sustain level (0..1)
    this.R = opts.r ?? 0.2; // release seconds

    // Nodes
    this.osc = this.ctx.createOscillator();
    this.osc.type = this.wave;

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = this.cutoff;
    this.filter.Q.value = this.q;

    this.env = this.ctx.createGain();
    this.env.gain.value = 0.0; // start silent, we’ll ramp

    // Wiring: osc → filter → env → destination
    this.osc.connect(this.filter);
    this.filter.connect(this.env);
    this.env.connect(destination);

    // Bookkeeping
    this.started = false;
    this.stopped = false;
  }

  // MIDI note number → Hz  (A4=440 at note 69)
  mtof(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  // Simple perceptual velocity->gain mapping (square curve)
  velToGain(vel) {
    const v = Math.max(0, Math.min(127, vel)) / 127;
    return v * v; // 0..1, feels more natural than linear
  }

  setFilter(cutoffHz, q) {
    if (typeof cutoffHz === "number")
      this.filter.frequency.setTargetAtTime(
        cutoffHz,
        this.ctx.currentTime,
        0.01
      );
    if (typeof q === "number")
      this.filter.Q.setTargetAtTime(q, this.ctx.currentTime, 0.01);
  }

  /**
   * Start the voice with ADSR envelope
   * @param {number} midiNote
   * @param {number} velocity 0..127
   * @param {number} when ctx.currentTime or future time
   */
  start(midiNote, velocity = 100, when = this.ctx.currentTime) {
    if (this.started) return;
    this.started = true;

    const f = this.mtof(midiNote);
    const peak = this.velToGain(velocity); // target peak based on velocity
    const t0 = Math.max(when, this.ctx.currentTime);

    // Osc setup
    this.osc.frequency.setValueAtTime(f, t0);
    this.osc.start(t0);

    // ADSR on env.gain
    const g = this.env.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(g.value, t0); // start from current (usually 0)
    g.linearRampToValueAtTime(peak, t0 + this.A); // Attack to peak
    g.linearRampToValueAtTime(peak * this.S, t0 + this.A + this.D); // Decay to sustain
  }

  /**
   * Release the voice
   * @param {number} when ctx.currentTime or future time
   */
  stop(when = this.ctx.currentTime) {
    if (this.stopped) return;
    this.stopped = true;

    const t0 = Math.max(when, this.ctx.currentTime);
    const g = this.env.gain;

    // Release ramp to 0, then stop & disconnect
    g.cancelScheduledValues(t0);
    g.setValueAtTime(g.value, t0);
    g.linearRampToValueAtTime(0, t0 + this.R);

    // Give a little time to finish the release before freeing nodes
    const TAIL = this.R + 0.05;
    this.osc.stop(t0 + TAIL);
    setTimeout(() => {
      try {
        this.osc.disconnect();
      } catch {}
      try {
        this.filter.disconnect();
      } catch {}
      try {
        this.env.disconnect();
      } catch {}
    }, TAIL * 1000 + 10);
  }
}
