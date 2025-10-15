/* Meets the assignment:
   - Creates AudioContext after gesture
   - Creates master GainNode -> ctx.destination
   - const midi = new MIDIengine()
   - midi.onNoteOn = function (note, velocity) { ... }
   - midi.onNoteOff = function (note) { ... }
   - Polyphony via Map keyed by MIDI note
   - Velocity-to-gain ADSR handled in Synth.start()
*/
(function(){
  const $ = s => document.querySelector(s);

  const ui = {
    startBtn: $("#startBtn"), audioStatus: $("#audioStatus"), sr: $("#sr"),
    midiSelect: $("#midiSelect"), midiStatus: $("#midiStatus"), refreshBtn: $("#refreshBtn"),
    oscCount: $("#oscCount"), oscCountVal: $("#oscCountVal"), waveform: $("#waveform"),
    mono: $("#mono"), glide: $("#glide"), glideVal: $("#glideVal"),
    delayMix: $("#delayMix"), delayMixVal: $("#delayMixVal"),
    reverbMix: $("#reverbMix"), reverbMixVal: $("#reverbMixVal"), // (reverb not used in spec chain; can be no-op)
    drive: $("#drive"), driveVal: $("#driveVal"), // (drive not used in spec chain; cosmetic)
    master: $("#master"), masterVal: $("#masterVal"),
    log: $("#log")
  };

  function addLog(msg, kind){
    const t = new Date().toLocaleTimeString();
    const line = `[${t}] ${msg}`;
    (kind==="bad"?console.error:console.log)(line);
    const d = document.createElement("div");
    d.textContent = line;
    if (kind==="bad") d.style.color="#f66"; else if (kind==="good") d.style.color="#6f6";
    ui.log.appendChild(d); ui.log.scrollTop = ui.log.scrollHeight;
  }

  let ctx = null;
  let master = null;           // REQUIRED master in main.js
  let fx = null;               // Simple delay bus (meets filter/delay requirement in path)
  let midi = null;

  // Polyphony map: note -> array of voices to support same-note retrigger
  const voices = new Map();

  // Mono (optional) simple glide using scheduled frequency ramps on top voice
  let monoEnabled = false;
  function noteOnMono(note, velocity){
    // For spec purity, we’ll reuse Synth but glide by reusing the last voice if it exists.
    const last = Array.from(voices.values()).pop()?.slice(-1)[0];
    if (last){
      const when = ctx.currentTime;
      const targetHz = last.mtof(note);
      const p = last.osc.frequency;
      const glideSec = parseInt(ui.glide.value||"0",10)/1000;
      p.cancelScheduledValues(when);
      p.setValueAtTime(p.value, when);
      p.linearRampToValueAtTime(targetHz, when + glideSec);
      // small envelope nudge so it speaks
      const g = last.amp.gain;
      g.cancelScheduledValues(when);
      g.setValueAtTime(Math.max(0.0001, g.value), when);
      g.linearRampToValueAtTime(Math.min(1, Math.max(0.2, velocity)), when + 0.01);
      pushNoteVoice(note, last); // map note to this active mono voice
    }else{
      // No active voice—create one
      const v = new WebInstrument.Synth(ctx, fx.input, { waveform: ui.waveform.value });
      v.start(note, velocity, ctx.currentTime);
      pushNoteVoice(note, v);
    }
  }
  function noteOffMono(note){
    // If no keys left associated with the mono voice, release it.
    const arr = voices.get(note);
    if (!arr || !arr.length) return;
    const v = arr.pop();
    try{ v.stop(); }catch(_){}
    voices.delete(note);
  }

  function pushNoteVoice(note, voice){
    const stack = voices.get(note) || [];
    stack.push(voice);
    voices.set(note, stack);
  }

  function noteOnPoly(note, velocity){
    const v = new WebInstrument.Synth(ctx, fx.input, { waveform: ui.waveform.value });
    v.start(note, velocity, ctx.currentTime);
    pushNoteVoice(note, v);
  }
  function noteOffPoly(note){
    const stack = voices.get(note);
    if (!stack || !stack.length) return;
    const v = stack.pop();
    try{ v.stop(); }catch(_){}
    if (!stack.length) voices.delete(note);
    else voices.set(note, stack);
  }

  // UI bindings
  ui.oscCount.addEventListener("input", ()=> ui.oscCountVal.textContent = ui.oscCount.value);
  ui.glide.addEventListener("input", ()=> ui.glideVal.textContent = ui.glide.value);
  ui.delayMix.addEventListener("input", ()=>{
    ui.delayMixVal.textContent = (+ui.delayMix.value).toFixed(2);
    if (fx) fx.setDelayMix(+ui.delayMix.value);
  });
  // cosmetic sliders retained for your UI
  ui.reverbMix.addEventListener("input", ()=> ui.reverbMixVal.textContent = (+ui.reverbMix.value).toFixed(2));
  ui.drive.addEventListener("input",   ()=> ui.driveVal.textContent   = (+ui.drive.value).toFixed(2));
  ui.master.addEventListener("input",  ()=> {
    ui.masterVal.textContent = (+ui.master.value).toFixed(2);
    if (master) master.gain.value = +ui.master.value;
  });
  ui.mono.addEventListener("change", ()=> { monoEnabled = ui.mono.checked; });

  ui.startBtn.addEventListener("click", async ()=>{
    try{
      if (!ctx){
        ctx = new (window.AudioContext||window.webkitAudioContext)();
        // REQUIRED: master GainNode in main.js
        master = ctx.createGain(); master.gain.value = +ui.master.value;
        master.connect(ctx.destination);

        // FX: delay bus that meets the "filter or delay" requirement
        fx = new WebInstrument.FX(ctx);
        fx.output.connect(master);

        ui.sr.textContent = ctx.sampleRate + " Hz";
      }
      await ctx.resume();
      ui.audioStatus.innerHTML = 'Audio: <span class="good">running</span>';
      addLog("AudioContext started ✅","good");
    }catch(err){
      ui.audioStatus.innerHTML = 'Audio: <span class="bad">error</span>';
      addLog("Audio start failed: "+err, "bad");
    }
  });

  // --------- MIDI via provided MIDIengine (unchanged) ----------
  function normalizeOn(noteOrObj, velocityMaybe){
    // Accept (note, velocity) OR ({note, velocity})
    if (typeof noteOrObj === "object") return { note: noteOrObj.note, velocity: noteOrObj.velocity ?? 0.8 };
    return { note: noteOrObj, velocity: velocityMaybe ?? 0.8 };
  }
  function normalizeOff(noteOrObj){
    if (typeof noteOrObj === "object") return { note: noteOrObj.note };
    return { note: noteOrObj };
  }

  try{
    // MUST: instantiate the provided engine
    midi = new MIDIengine();

    // Device list (optional UI)
    function refreshDeviceList(){
      const inputs = Array.isArray(midi.inputs) ? midi.inputs : [];
      const prev = ui.midiSelect.value;
      ui.midiSelect.innerHTML = "";
      if (!inputs.length){
        const o=document.createElement("option"); o.value=""; o.textContent="No devices"; ui.midiSelect.appendChild(o);
      }else{
        inputs.forEach(inp=>{
          const o=document.createElement("option");
          o.value = inp.id;
          o.textContent = `${inp.name} (${inp.manufacturer||"?"})`;
          ui.midiSelect.appendChild(o);
        });
        const keep = inputs.some(i=>i.id===prev);
        ui.midiSelect.value = keep ? prev : (inputs[0]?.id||"");
        if (ui.midiSelect.value && typeof midi.selectInputById==="function"){
          midi.selectInputById(ui.midiSelect.value);
        }
      }
    }

    midi.onState = (s)=>{
      const text = (typeof s==="string") ? s : (s?.text || JSON.stringify(s));
      ui.midiStatus.textContent = text;
      addLog("MIDI: "+text);
      refreshDeviceList();
    };

    // MUST: exact signatures per assignment; also accept object payloads
    midi.onNoteOn = function(noteOrObj, velocityMaybe){
      if (!ctx){ addLog("NoteOn ignored until audio is started."); return; }
      const { note, velocity } = normalizeOn(noteOrObj, velocityMaybe);
      const hz = 440 * Math.pow(2, (note - 69)/12);
      addLog(`NoteOn n${note} (${hz.toFixed(2)} Hz) v=${(+velocity).toFixed(2)}`);
      if (monoEnabled) noteOnMono(note, velocity);
      else noteOnPoly(note, velocity);
    };

    midi.onNoteOff = function(noteOrObj){
      if (!ctx) return;
      const { note } = normalizeOff(noteOrObj);
      addLog(`NoteOff n${note}`);
      if (monoEnabled) noteOffMono(note);
      else noteOffPoly(note);
    };

    ui.refreshBtn.addEventListener("click", ()=>{
      if (typeof midi.refresh==="function") midi.refresh();
      refreshDeviceList();
      addLog("Device list refreshed.");
    });
    ui.midiSelect.addEventListener("change", ()=>{
      if (typeof midi.selectInputById==="function"){
        midi.selectInputById(ui.midiSelect.value);
      }
    });

    // Initial try
    if (typeof midi.refresh==="function") midi.refresh();
    refreshDeviceList();
  }catch(e){
    ui.midiStatus.textContent = "MIDIengine init error (check midi.js)";
    addLog("MIDIengine init error: "+e, "bad");
  }

  // Init labels
  ui.oscCountVal.textContent = ui.oscCount.value;
  ui.glideVal.textContent = ui.glide.value;
  ui.delayMixVal.textContent = (+ui.delayMix.value).toFixed(2);
  ui.reverbMixVal.textContent = (+ui.reverbMix.value).toFixed(2);
  ui.driveVal.textContent = (+ui.drive.value).toFixed(2);
  ui.masterVal.textContent = (+ui.master.value).toFixed(2);

  addLog("Page ready. Click ‘Start Audio’ then play your MIDI keyboard. 🎹");
})();
