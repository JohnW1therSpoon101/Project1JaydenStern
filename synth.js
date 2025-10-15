/* Single-voice Synth class meeting the spec, plus a tiny FX rack.
   - OscillatorNode
   - GainNode (amplitude envelope)
   - DelayNode in the signal path
   - mtof implemented INSIDE the class
   - start(midiNote, velocity, when), stop(when)
*/
(function(){
  function clamp(x,min,max){ return Math.min(max, Math.max(min, x)); }

  // Simple FX bus (delay + wet/dry), leaves master gain to main.js per spec
  function FX(ctx){
    this.input = ctx.createGain();

    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = 0.28;
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.35;
    this.delayMix = ctx.createGain(); this.delayMix.gain.value = 0.15; // wet default
    this.dry = ctx.createGain(); this.dry.gain.value = 1.0;

    // Routing: input -> dry, input -> delay loop -> wet
    this.input.connect(this.dry);
    this.input.connect(this.delay);
    this.delay.connect(this.delayFb); this.delayFb.connect(this.delay);
    this.delay.connect(this.delayMix);

    // Output node to be connected by main.js
    this.output = ctx.createGain();
    this.dry.connect(this.output);
    this.delayMix.connect(this.output);
  }

  FX.prototype.setDelayMix = function(v){ this.delayMix.gain.value = clamp(v,0,1); };

  // === Synth class required by the assignment ===
  function Synth(ctx, destination, opts){
    this.ctx = ctx;
    this.dest = destination; // usually an FX input
    this.opts = Object.assign({
      waveform: "sawtooth",
      attack: 0.01,
      decay: 0.12,
      sustain: 0.7,
      release: 0.2
    }, opts||{});

    // Core nodes
    this.osc = ctx.createOscillator();
    this.osc.type = this.opts.waveform;

    // Envelope gain (amplitude envelope)
    this.amp = ctx.createGain();
    this.amp.gain.value = 0.0;

    // DelayNode (meets the "filter or delay" requirement)
    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = 0.25;

    // Connect: osc -> amp -> delay -> destination
    this.osc.connect(this.amp);
    this.amp.connect(this.delay);
    this.delay.connect(this.dest);

    this.started = false;
  }

  // MIDI note to frequency implemented INSIDE the class
  Synth.prototype.mtof = function(note){
    return 440 * Math.pow(2, (note - 69) / 12);
  };

  // start(midiNote, velocity, when?)
  Synth.prototype.start = function(midiNote, velocity=0.8, when){
    const t0 = when ?? this.ctx.currentTime;
    const freq = this.mtof(midiNote);

    this.osc.frequency.setValueAtTime(freq, t0);
    if (!this.started){ try{ this.osc.start(t0); }catch(_){ /* idempotent */ } this.started = true; }

    // ADSR
    const g = this.amp.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(clamp(velocity,0,1), t0 + this.opts.attack);
    g.linearRampToValueAtTime(clamp(velocity*this.opts.sustain,0,1), t0 + this.opts.attack + this.opts.decay);
  };

  // stop(when?)
  Synth.prototype.stop = function(when){
    const t0 = when ?? this.ctx.currentTime;
    const g = this.amp.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(g.value, t0);
    g.linearRampToValueAtTime(0, t0 + this.opts.release);
    try{ this.osc.stop(t0 + this.opts.release + 0.02); }catch(_){}
  };

  // Expose minimal API used by main.js
  window.WebInstrument = { FX, Synth };
})();
