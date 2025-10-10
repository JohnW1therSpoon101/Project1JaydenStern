class SimpleFX {
  constructor(ctx, { log = console.log } = {}) {
    this.ctx = ctx; this.log = log;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    // Distortion
    this.drive = 0.3;
    this.shaper = ctx.createWaveShaper();
    this._updateCurve();

    // Delay
    this.delay = ctx.createDelay(1.2);
    this.delay.delayTime.value = 0.25;
    this.delayMix = ctx.createGain(); this.delayMix.gain.value = 0.2;
    this.delayFB = ctx.createGain(); this.delayFB.gain.value = 0.35;

    // Reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(1.8);
    this.reverbMix = ctx.createGain(); this.reverbMix.gain.value = 0.2;

    this.input = ctx.createGain();
    this.input.connect(this.shaper);
    this.shaper.connect(this.master);
    this.shaper.connect(this.reverb);
    this.reverb.connect(this.reverbMix);
    this.reverbMix.connect(this.master);
    this.shaper.connect(this.delay);
    this.delay.connect(this.delayFB);
    this.delayFB.connect(this.delay);
    this.delay.connect(this.delayMix);
    this.delayMix.connect(this.master);
    this.master.connect(ctx.destination);
  }

  setReverbMix(v){ this.reverbMix.gain.value = v; }
  setDistortionDrive(v){ this.drive = v; this._updateCurve(); }
  setDelayMix(v){ this.delayMix.gain.value = v; }
  setDelayTimeMs(ms){ this.delay.delayTime.value = ms / 1000; }

  _updateCurve(){
    const k = 1 + this.drive * 150;
    const n = 2048; const curve = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
    }
    this.shaper.curve = curve; this.shaper.oversample = '4x';
  }

  _makeImpulse(seconds){
    const rate = this.ctx.sampleRate; const len = Math.floor(seconds * rate);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++){
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i/len, 2.8);
    }
    return buf;
  }
}

class SynthVoice {
  constructor(ctx, out, { glideMs = 0 } = {}){
    this.ctx = ctx; this.out = out; this.glideMs = glideMs;
    this.osc = ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.vcf = ctx.createBiquadFilter(); this.vcf.type = 'lowpass'; this.vcf.frequency.value = 12000;
    this.amp = ctx.createGain(); this.amp.gain.value = 0.0;
    this.osc.connect(this.vcf); this.vcf.connect(this.amp); this.amp.connect(out);
    this.osc.start();
    this.A = 0.005; this.D = 0.08; this.S = 0.65; this.R = 0.18;
  }

  trigger(freq, velocity, legatoFromFreq = null){
    const t = this.ctx.currentTime;
    if (legatoFromFreq != null) {
      this.osc.frequency.setValueAtTime(legatoFromFreq, t);
      const glide = this.glideMs / 1000;
      this.osc.frequency.linearRampToValueAtTime(freq, t + glide);
    } else this.osc.frequency.setValueAtTime(freq, t);
    this.amp.gain.setValueAtTime(0, t);
    this.amp.gain.linearRampToValueAtTime(velocity, t + this.A);
    this.amp.gain.linearRampToValueAtTime(this.S * velocity, t + this.A + this.D);
  }

  release(){
    const t = this.ctx.currentTime;
    this.amp.gain.cancelScheduledValues(t);
    this.amp.gain.setTargetAtTime(0, t, this.R);
    setTimeout(() => { try { this.osc.stop(); } catch{} }, this.R * 1000 + 120);
  }

  setGlideMs(ms){ this.glideMs = ms; }
}

class PolySynth {
  constructor(ctx, { log = console.log } = {}){
    this.ctx = ctx; this.log = log;
    this.fx = new SimpleFX(ctx, { log });
    this.active = new Map();
    this.lastFreq = null;
  }

  setGlideMs(ms){ this.glideMs = ms; }

  noteOn(note, freq, velocity){
    const arr = this.active.get(note) || [];
    const legatoFrom = this._anyHeld() ? this.lastFreq : null;
    const v = new SynthVoice(this.ctx, this.fx.input, { glideMs: this.glideMs });
    v.trigger(freq, velocity, legatoFrom);
    arr.push(v);
    this.active.set(note, arr);
    this.lastFreq = freq;
  }

  noteOff(note){
    const arr = this.active.get(note);
    if (!arr?.length) return;
    const v = arr.pop();
    if (v) v.release();
    if (!arr.length) this.active.delete(note);
    if (!this._anyHeld()) this.lastFreq = null;
  }

  _anyHeld(){ for (const [, arr] of this.active) if (arr.length) return true; return false; }
}
