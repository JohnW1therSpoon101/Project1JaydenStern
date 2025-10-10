// Classic script version (no modules) + verbose logging + RETRIGGER
(function () {
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function nowStr() {
    return new Date().toISOString();
  }
  function log(...a) {
    console.log(`[synth ${nowStr()}]`, ...a);
  }

  function SynthVoice(audioCtx, destination, opts) {
    this.ctx = audioCtx;
    this.opts = Object.assign(
      { type: "sawtooth", attack: 0.01, release: 0.12 },
      opts || {}
    );

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 4000;
    this.filter.Q.value = 1.0;

    this.out = this.ctx.createGain();
    this.out.gain.value = 0.0;

    this.filter.connect(this.out);
    this.out.connect(destination);

    this.osc = this.ctx.createOscillator();
    this.osc.type = this.opts.type;
    this.osc.connect(this.filter);
    this.started = false;

    log("Voice created", {
      type: this.osc.type,
      attack: this.opts.attack,
      release: this.opts.release,
    });
  }

  SynthVoice.prototype.setWave = function (type) {
    if (this.osc) this.osc.type = type;
    log("Wave set", type);
  };

  SynthVoice.prototype.setFilter = function (cutoff, q) {
    const now = this.ctx.currentTime;
    this.filter.frequency.setValueAtTime(cutoff, now);
    this.filter.Q.setValueAtTime(q, now);
    log("Filter set", { cutoff, q });
  };

  // Normal start (first Note On for a note)
  SynthVoice.prototype.start = function (freq, velocity) {
    const now = this.ctx.currentTime;
    if (!this.started) {
      this.osc.start();
      this.started = true;
    }
    this.osc.frequency.setValueAtTime(freq, now);

    const vel = clamp(velocity || 100, 0, 127);
    const peak = (vel / 127) * 0.35;
    const atk = this.opts.attack;

    this.out.gain.cancelScheduledValues(now);
    // retrigger-friendly: start from a very low value (avoids clicks)
    this.out.gain.setValueAtTime(0.0001, now);
    this.out.gain.linearRampToValueAtTime(peak, now + atk);
    this.out.gain.linearRampToValueAtTime(peak * 0.95, now + atk + 0.05);

    log("Note start", { freq, velocity: vel, peak, atk });
  };

  // NEW: explicit retrigger when the same note gets pressed again
  SynthVoice.prototype.retrigger = function (freq, velocity) {
    const now = this.ctx.currentTime;
    if (!this.started) {
      this.osc.start();
      this.started = true;
    }
    if (typeof freq === "number") this.osc.frequency.setValueAtTime(freq, now);

    const vel = clamp(velocity || 100, 0, 127);
    const peak = (vel / 127) * 0.35;
    const atk = this.opts.attack;

    // Hard reset envelope to a tiny value, then run the attack again
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0.0001, now);
    this.out.gain.linearRampToValueAtTime(peak, now + atk);
    this.out.gain.linearRampToValueAtTime(peak * 0.95, now + atk + 0.05);

    log("Retrigger", { velocity: vel, peak, atk });
  };

  SynthVoice.prototype.stop = function () {
    const now = this.ctx.currentTime;
    const rel = this.opts.release;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0.0001, now + rel);
    log("Note stop (release)", { release: rel });
  };

  SynthVoice.prototype.dispose = function () {
    try {
      this.osc.stop();
    } catch {}
    this.osc.disconnect();
    this.filter.disconnect();
    this.out.disconnect();
    log("Voice disposed");
  };

  window.SynthVoice = SynthVoice;
  console.log("[synth] SynthVoice ready (classic script with retrigger)");
})();
