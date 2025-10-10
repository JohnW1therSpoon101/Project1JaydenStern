// synth.js (ES Module)
// A lightweight poly / mono Web Audio synth with delay, reverb and distortion.
// Designed to plug into the UI events and helpers provided in index.html.

export class Synth {
  constructor(ctx) {
    this.ctx = ctx;

    // ----------------- Global Params (reflect UI) -----------------
    this.params = {
      oscCount: 1,
      waveform: 'sine',
      mono: false,
      glideMs: 90,
      masterGain: 0.6,

      // FX
      delay: {
        mix: 0.0,
        timeMs: 320,
        feedback: 0.35
      },
      reverb: {
        mix: 0.0,
        decaySec: 2.8,
        preDelayMs: 20
      },
      distortion: {
        drive: 0.0 // 0..1
      },

      maxVoices: 16
    };

    // ----------------- Audio Graph -----------------
    this.master = ctx.createGain();
    this.master.gain.value = this.params.masterGain;
    this.master.connect(ctx.destination);

    // Delay bus
    this.delayInput = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delayFeedback = ctx.createGain();
    this.delayMix = ctx.createGain();

    this.delayInput.connect(this.delay);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.delayMix);
    this.delayMix.connect(this.master);

    // Reverb bus
    this.reverbInput = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.reverbMix = ctx.createGain();

    this.reverbInput.connect(this.convolver);
    this.convolver.connect(this.reverbMix);
    this.reverbMix.connect(this.master);

    // Apply initial FX params
    this._applyDelayParams();
    this._applyReverbParams(true); // build initial impulse

    // ----------------- State -----------------
    this.voices = new Map();       // voiceId -> Voice
    this.noteStacks = new Map();   // midiNote -> [voiceId, ...] (stack)
    this.pressedNotes = new Set(); // for mono handling
    this.voiceCounter = 0;

    // Mono "always-on" voice (when enabled)
    this.monoVoiceId = null;

    this._log('Synth initialized.');
  }

  // ---------- Logging helpers ----------
  _log(msg, level = 'info') {
    console[level === 'error' ? 'error' : 'log']('[Synth]', msg);
    if (typeof window !== 'undefined' && window.uiLog) {
      window.uiLog(msg, level);
    }
  }

  // ---------- Parameter setters ----------
  setOscCount(n) {
    const v = Math.max(1, Math.min(3, parseInt(n, 10) || 1));
    this.params.oscCount = v;
    this._log(`Oscillators set to ${v}`);
    // update existing voices
    this._forEachVoice(voice => voice.setOscCount(v));
  }
  setWaveform(type) {
    this.params.waveform = type || 'sine';
    this._log(`Waveform set to ${this.params.waveform}`);
    this._forEachVoice(voice => voice.setWaveform(this.params.waveform));
  }
  setMono(enabled) {
    this.params.mono = !!enabled;
    this._log(`Mono mode ${this.params.mono ? 'ENABLED' : 'disabled'}`);
    if (!this.params.mono && this.monoVoiceId) {
      // If turning mono OFF, release any lingering mono voice
      const v = this.voices.get(this.monoVoiceId);
      if (v) v.release();
      this.voices.delete(this.monoVoiceId);
      this.monoVoiceId = null;
    }
  }
  setGlide(ms) {
    this.params.glideMs = Math.max(0, parseFloat(ms) || 0);
    this._log(`Glide set to ${this.params.glideMs} ms`);
  }
  setMasterGain(g) {
    const val = clamp(parseFloat(g) || 0, 0, 1);
    this.params.masterGain = val;
    this.master.gain.setTargetAtTime(val, this.ctx.currentTime, 0.01);
  }

  setDistortionDrive(d) {
    const val = clamp(parseFloat(d) || 0, 0, 1);
    this.params.distortion.drive = val;
    this._log(`Distortion drive ${val.toFixed(2)}`);
    this._forEachVoice(v => v.setDrive(val));
  }

  // Delay
  setDelayMix(mix) {
    const v = clamp(parseFloat(mix) || 0, 0, 1);
    this.params.delay.mix = v;
    this.delayMix.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
  setDelayTime(ms) {
    const v = clamp(parseFloat(ms) || 0, 1, 2000);
    this.params.delay.timeMs = v;
    this.delay.delayTime.setTargetAtTime(v / 1000, this.ctx.currentTime, 0.02);
  }
  setDelayFeedback(fb) {
    const v = clamp(parseFloat(fb) || 0, 0, 0.95);
    this.params.delay.feedback = v;
    this.delayFeedback.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // Reverb
  setReverbMix(mix) {
    const v = clamp(parseFloat(mix) || 0, 0, 1);
    this.params.reverb.mix = v;
    this.reverbMix.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
  setReverbDecay(sec) {
    const v = clamp(parseFloat(sec) || 0, 0.1, 12);
    this.params.reverb.decaySec = v;
    this._applyReverbParams();
  }
  setReverbPreDelay(ms) {
    const v = clamp(parseFloat(ms) || 0, 0, 200);
    this.params.reverb.preDelayMs = v;
    this._applyReverbParams();
  }

  _applyDelayParams() {
    this.setDelayTime(this.params.delay.timeMs);
    this.setDelayFeedback(this.params.delay.feedback);
    this.setDelayMix(this.params.delay.mix);
  }
  _applyReverbParams(initial = false) {
    // Build/Update impulse buffer
    const { decaySec, preDelayMs } = this.params.reverb;
    this.convolver.buffer = buildImpulse(this.ctx, decaySec, preDelayMs);
    if (!initial) this._log(`Reverb IR rebuilt (decay ${decaySec}s, predelay ${preDelayMs}ms)`);
    this.setReverbMix(this.params.reverb.mix);
  }

  // ---------- Note handling ----------
  noteOn(midiNote, velocity = 100) {
    const freq = mtof(midiNote);
    const vel = clamp(velocity / 127, 0, 1);

    if (this.params.mono) {
      // Single voice; glide frequency
      if (!this.monoVoiceId) {
        const vid = this._createVoice(freq, vel);
        this.monoVoiceId = vid;
      } else {
        const v = this.voices.get(this.monoVoiceId);
        if (v) {
          v.setFrequencySmooth(freq, this.params.glideMs);
          v.trigger(vel); // retrigger amp env for every press
        }
      }
      this.pressedNotes.add(midiNote);
      return;
    }

    // Poly mode — create NEW voice on every noteOn (even duplicate notes)
    const vid = this._createVoice(freq, vel);

    // Track stack for this note
    if (!this.noteStacks.has(midiNote)) this.noteStacks.set(midiNote, []);
    this.noteStacks.get(midiNote).push(vid);

    // Limit polyphony (voice stealing: release oldest)
    if (this.voices.size > this.params.maxVoices) {
      const oldestId = [...this.voices.keys()][0];
      const ov = this.voices.get(oldestId);
      if (ov) ov.release();
      this.voices.delete(oldestId);
      // Also clean from any stacks
      for (const stack of this.noteStacks.values()) {
        const idx = stack.indexOf(oldestId);
        if (idx >= 0) stack.splice(idx, 1);
      }
      this._log('Voice stealing occurred (poly limit).');
    }
  }

  noteOff(midiNote) {
    if (this.params.mono) {
      this.pressedNotes.delete(midiNote);
      if (this.pressedNotes.size === 0 && this.monoVoiceId) {
        const v = this.voices.get(this.monoVoiceId);
        if (v) v.release();
        // keep node for a bit to finish release; will be GC'd by cleanup
      }
      return;
    }

    const stack = this.noteStacks.get(midiNote);
    if (stack && stack.length) {
      // Release the most recent (LIFO) to mirror repeated-note retriggers
      const vid = stack.pop();
      const voice = this.voices.get(vid);
      if (voice) voice.release();
    }
  }

  // ---------- Internals ----------
  _createVoice(freq, vel) {
    const id = ++this.voiceCounter;
    const voice = new Voice(this.ctx, {
      id,
      freq,
      vel,
      waveform: this.params.waveform,
      oscCount: this.params.oscCount,
      drive: this.params.distortion.drive,
      targets: {
        dry: this.master,
        delaySend: this.delayInput,
        reverbSend: this.reverbInput
      }
    });
    this.voices.set(id, voice);
    voice.onEnded = () => {
      this.voices.delete(id);
      // remove from any stacks
      for (const [note, stack] of this.noteStacks) {
        const idx = stack.indexOf(id);
        if (idx >= 0) stack.splice(idx, 1);
        if (stack.length === 0) this.noteStacks.delete(note);
      }
      if (this.monoVoiceId === id) this.monoVoiceId = null;
    };
    voice.trigger(vel);
    return id;
  }

  _forEachVoice(fn) {
    for (const v of this.voices.values()) fn(v);
  }
}

// ---------- Voice ----------
class Voice {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.id = opts.id;
    this.waveform = opts.waveform || 'sine';
    this.oscCount = opts.oscCount || 1;
    this.drive = clamp(opts.drive ?? 0, 0, 1);
    this.onEnded = null;

    // Nodes
    this.mix = ctx.createGain();     // sum of oscillators
    this.dist = ctx.createWaveShaper();
    this.amp = ctx.createGain();     // amplitude envelope
    this.amp.gain.value = 0;

    this._setDriveCurve(this.drive);

    // Split after amp to buses (dry + sends)
    this.amp.connect(opts.targets.dry);
    this.amp.connect(opts.targets.delaySend);
    this.amp.connect(opts.targets.reverbSend);

    // Connect osc -> dist -> amp
    this.mix.connect(this.dist);
    this.dist.connect(this.amp);

    this.oscs = [];
    this.freq = opts.freq || 440;

    this._createOscillators(this.oscCount, this.waveform, this.freq);

    // Envelope timings (simple ADSR)
    this.env = { attack: 0.005, decay: 0.08, sustain: 0.85, release: 0.25 };

    // For glide operations
    this.lastFreq = this.freq;

    this.stopped = false;
  }

  _createOscillators(count, type, freq) {
    // Disconnect existing oscillators
    for (const o of this.oscs) {
      try { o.stop(); } catch {}
      try { o.disconnect(); } catch {}
    }
    this.oscs = [];

    for (let i = 0; i < count; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      // slight detune for >1 oscs
      const det = (i === 0) ? 0 : (i % 2 === 0 ? 6 : -6); // +/- cents
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.detune.setValueAtTime(det, this.ctx.currentTime);
      osc.connect(this.mix);
      osc.start();
      this.oscs.push(osc);
    }
  }

  setOscCount(n) {
    const count = Math.max(1, Math.min(3, parseInt(n, 10) || 1));
    if (count === this.oscs.length) return;
    this.oscCount = count;
    this._createOscillators(this.oscCount, this.waveform, this.freq);
  }
  setWaveform(type) {
    this.waveform = type || 'sine';
    for (const o of this.oscs) o.type = this.waveform;
  }
  setDrive(d) {
    this.drive = clamp(parseFloat(d) || 0, 0, 1);
    this._setDriveCurve(this.drive);
  }
  _setDriveCurve(amount) {
    // Smooth arctangent curve
    const k = amount * 100 + 1;
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.atan(k * x) / Math.atan(k);
    }
    this.dist.curve = curve;
    this.dist.oversample = '4x';
  }

  setFrequencySmooth(freq, glideMs = 0) {
    this.freq = freq;
    const t0 = this.ctx.currentTime;
    const t1 = t0 + Math.max(0, glideMs) / 1000;
    for (const o of this.oscs) {
      o.frequency.cancelScheduledValues(t0);
      if (glideMs > 0) {
        o.frequency.setValueAtTime(o.frequency.value, t0);
        o.frequency.linearRampToValueAtTime(freq, t1);
      } else {
        o.frequency.setValueAtTime(freq, t0);
      }
    }
    this.lastFreq = freq;
  }

  trigger(vel = 1.0) {
    const now = this.ctx.currentTime;
    const { attack, decay, sustain } = this.env;
    const peak = Math.max(0.0001, vel);

    this.amp.gain.cancelScheduledValues(now);
    this.amp.gain.setValueAtTime(this.amp.gain.value, now);
    this.amp.gain.linearRampToValueAtTime(peak, now + attack);
    this.amp.gain.linearRampToValueAtTime(peak * sustain, now + attack + decay);
  }

  release() {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    const { release } = this.env;

    this.amp.gain.cancelScheduledValues(now);
    this.amp.gain.setValueAtTime(this.amp.gain.value, now);
    this.amp.gain.linearRampToValueAtTime(0.0001, now + release);

    // stop oscillators after release
    const stopAt = now + release + 0.05;
    for (const o of this.oscs) {
      try { o.stop(stopAt); } catch {}
    }
    // notify end a bit later to let nodes finish
    setTimeout(() => this.onEnded && this.onEnded(), (release + 0.1) * 1000);
  }
}

// ---------- Utils ----------
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function mtof(m) {
  // MIDI 69 -> 440Hz
  return 440 * Math.pow(2, (m - 69) / 12);
}

function buildImpulse(ctx, decaySec = 2.5, preDelayMs = 20) {
  // Simple noise-based IR with exponential decay + pre-delay (silence prefix)
  const rate = ctx.sampleRate;
  const pre = Math.max(0, Math.round((preDelayMs / 1000) * rate));
  const len = Math.round((decaySec + preDelayMs / 1000) * rate);
  const buffer = ctx.createBuffer(2, len, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      if (i < pre) {
        data[i] = 0;
      } else {
        const t = (i - pre) / rate;
        // exp decay
        const decay = Math.pow(1 - t / decaySec, 3);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
  }
  return buffer;
}
