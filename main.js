/* main.js — COMPLETE
   - Verbose logs to both console AND on-page "Logs" box
   - Uses provided MIDIengine when available; falls back to Web MIDI
   - Same-note retriggering (fresh voice each tap)
   - Glide (portamento) + FX sliders (reverb, distortion, delay) wired live
   - Start/Stop Audio buttons with status text
*/

(() => {
  // ---------- Tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const logBox = $("logs");

  function now() {
    const d = new Date();
    return d.toISOString().replace("T", " ").replace("Z", "");
  }

  function vlog(tag, ...args) {
    // pretty console log
    console.log(`[${now()}] [${tag}]`, ...args);
    // UI log panel (if present)
    if (logBox) {
      const msg = args
        .map(a =>
          typeof a === "object" ? JSON.stringify(a, null, 0) : String(a)
        )
        .join(" ");
      logBox.textContent += `\n[${now()}] [${tag}] ${msg}`;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // ---------- DOM refs ----------
  const statusEl = $("status");
  const deviceEl = $("deviceInfo");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");

  const glideRange = $("glide");
  const reverbRange = $("reverb");
  const distRange = $("dist");
  const delayMixRange = $("delayMix");
  const delayTimeRange = $("delayTime");

  const glideVal = $("glideVal");
  const reverbVal = $("reverbVal");
  const distVal = $("distVal");
  const delayMixVal = $("delayMixVal");
  const delayTimeVal = $("delayTimeVal");

  // ---------- Audio / Synth ----------
  let audioCtx = null;
  let synth = null;
  let midiConnected = false;

  const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
    vlog("STATUS", text);
  }

  function ensureAudio() {
    if (audioCtx) return;

    vlog("AUDIO", "Creating AudioContext…");
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // PolySynth defined in synth.js (no modules)
    synth = new PolySynth(audioCtx, { log: (...a) => vlog("SYNTH", ...a) });

    // Initialize FX / glide from UI sliders (if present)
    const g = Number(glideRange?.value ?? 0);
    const rv = Number(reverbRange?.value ?? 0.2);
    const dv = Number(distRange?.value ?? 0.3);
    const dm = Number(delayMixRange?.value ?? 0.2);
    const dt = Number(delayTimeRange?.value ?? 250);

    synth.setGlideMs(g);
    synth.fx.setReverbMix(rv);
    synth.fx.setDistortionDrive(dv);
    synth.fx.setDelayMix(dm);
    synth.fx.setDelayTimeMs(dt);

    vlog("AUDIO", "AudioContext created. Initial params:", { g, rv, dv, dm, dt });

    // expose a little debug hook
    window.DEBUG = Object.assign(window.DEBUG || {}, {
      ctx: audioCtx,
      synth,
      dumpVoices() {
        vlog("DEBUG", "Active voices map:", synth?.active);
      },
    });
  }

  // ---------- MIDI Handling ----------
  function connectMIDI() {
    if (midiConnected) {
      vlog("MIDI", "Already connected; skipping.");
      return;
    }

    // Prefer provided MIDIengine (from your midi.js)
    if (typeof MIDIengine !== "undefined") {
      vlog("MIDI", "Using provided MIDIengine.");
      try {
        const me = new MIDIengine();

        me.onStateChange = (txt) => vlog("MIDIengine", "State:", txt);
        me.onDeviceChange = (name) => {
          deviceEl && (deviceEl.textContent = name || "No device");
          vlog("MIDIengine", "Device change:", name);
        };
        me.onNoteOn = (note, velocity, channel) => handleNoteOn(note, velocity, channel);
        me.onNoteOff = (note, velocity, channel) => handleNoteOff(note, velocity, channel);
        if (typeof me.onControlChange === "function") {
          me.onControlChange = (cc, val, ch) => vlog("MIDIengine", "CC", { cc, val, ch });
        }

        me.init()
          .then(() => {
            midiConnected = true;
            vlog("MIDIengine", "Ready.");
          })
          .catch((err) => vlog("ERROR", "MIDIengine init failed:", err));

        deviceEl && (deviceEl.textContent = "MIDIengine: initializing…");

      } catch (err) {
        vlog("ERROR", "MIDIengine threw during setup:", err);
      }
      return;
    }

    // Fallback to native Web MIDI
    if (!navigator.requestMIDIAccess) {
      vlog("ERROR", "Web MIDI API not supported in this browser.");
      deviceEl && (deviceEl.textContent = "No Web MIDI support");
      return;
    }

    vlog("MIDI", "Using native Web MIDI.");
    navigator.requestMIDIAccess().then(
      (access) => {
        midiConnected = true;

        access.onstatechange = (e) =>
          vlog("MIDI", "statechange:", e.port?.name, e.port?.state, e.port?.type);

        const inputs = Array.from(access.inputs.values());
        deviceEl &&
          (deviceEl.textContent = inputs.length ? `Input: ${inputs[0].name}` : "No MIDI input");

        inputs.forEach((inp) => {
          vlog("MIDI", "Binding input:", inp.name);
          inp.onmidimessage = (e) => {
            const [st, d1, d2] = e.data;
            const cmd = st & 0xf0;
            const ch = st & 0x0f;

            if (cmd === 0x90 && d2 > 0) {
              handleNoteOn(d1, d2, ch);
            } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
              handleNoteOff(d1, d2, ch);
            } else {
              // optional visibility of other events
              // vlog("MIDI", "Unhandled msg", { st, d1, d2 });
            }
          };
        });

        vlog("MIDI", "Native Web MIDI ready. Inputs:", inputs.map(i => i.name));
      },
      (err) => {
        vlog("ERROR", "requestMIDIAccess failed:", err);
      }
    );
  }

  // ---------- Note handlers (same-note retrigger preserved) ----------
  function handleNoteOn(note, velocity = 100, channel = 0) {
    ensureAudio();
    const freq = mtof(note);
    const vel = Math.max(0.05, velocity / 127);
    vlog("NOTE", `ON n=${note} f=${freq.toFixed(2)}Hz vel=${vel.toFixed(2)} ch=${channel}`);
    try {
      synth.noteOn(note, freq, vel, channel);
      const arr = synth.active.get(note) || [];
      vlog("VOICES", `note ${note} voices=${arr.length} | totalHeld=${totalHeld()}`);
    } catch (err) {
      vlog("ERROR", "noteOn failed:", err);
    }
  }

  function handleNoteOff(note, _velocity = 0, channel = 0) {
    if (!synth) return;
    vlog("NOTE", `OFF n=${note} ch=${channel}`);
    try {
      synth.noteOff(note, channel);
      const arr = synth.active.get(note) || [];
      vlog("VOICES", `note ${note} voices=${arr.length} | totalHeld=${totalHeld()}`);
    } catch (err) {
      vlog("ERROR", "noteOff failed:", err);
    }
  }

  function totalHeld() {
    if (!synth) return 0;
    let n = 0;
    for (const [, arr] of synth.active) n += arr.length;
    return n;
  }

  // ---------- UI: Start/Stop ----------
  startBtn?.addEventListener("click", async () => {
    try {
      ensureAudio();
      await audioCtx.resume();
      setStatus("Audio running. Play your MIDI controller.");
      connectMIDI();
    } catch (err) {
      vlog("ERROR", "Start failed:", err);
    }
  });

  stopBtn?.addEventListener("click", () => {
    try {
      if (audioCtx && audioCtx.state !== "suspended") {
        audioCtx.suspend();
        setStatus("Audio suspended.");
        vlog("AUDIO", "AudioContext suspended.");
      }
    } catch (err) {
      vlog("ERROR", "Stop failed:", err);
    }
  });

  // ---------- UI: Sliders → live params ----------
  function pushUIToEngine() {
    if (!synth) return;
    const g = Number(glideRange?.value ?? 0);
    const rv = Number(reverbRange?.value ?? 0);
    const dv = Number(distRange?.value ?? 0);
    const dm = Number(delayMixRange?.value ?? 0);
    const dt = Number(delayTimeRange?.value ?? 250);

    if (glideVal) glideVal.textContent = g.toFixed(0);
    if (reverbVal) reverbVal.textContent = rv.toFixed(2);
    if (distVal) distVal.textContent = dv.toFixed(2);
    if (delayMixVal) delayMixVal.textContent = dm.toFixed(2);
    if (delayTimeVal) delayTimeVal.textContent = dt.toFixed(0);

    synth.setGlideMs(g);
    synth.fx.setReverbMix(rv);
    synth.fx.setDistortionDrive(dv);
    synth.fx.setDelayMix(dm);
    synth.fx.setDelayTimeMs(dt);

    vlog("UI→FX", { glideMs: g, reverbMix: rv, drive: dv, delayMix: dm, delayMs: dt });
  }

  const sliderEls = [glideRange, reverbRange, distRange, delayMixRange, delayTimeRange].filter(Boolean);
  sliderEls.forEach((el) => el.addEventListener("input", pushUIToEngine));

  // Prefill label values at load (even before audio init)
  (function primeLabels() {
    if (glideVal && glideRange) glideVal.textContent = Number(glideRange.value).toFixed(0);
    if (reverbVal && reverbRange) reverbVal.textContent = Number(reverbRange.value).toFixed(2);
    if (distVal && distRange) distVal.textContent = Number(distRange.value).toFixed(2);
    if (delayMixVal && delayMixRange) delayMixVal.textContent = Number(delayMixRange.value).toFixed(2);
    if (delayTimeVal && delayTimeRange) delayTimeVal.textContent = Number(delayTimeRange.value).toFixed(0);
  })();

  // Optional: resume audio on user gesture anywhere (some browsers require)
  window.addEventListener("pointerdown", async () => {
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
      setStatus("Audio running (auto-resume).");
    }
  });

  // Log visibility changes (handy for debugging)
  document.addEventListener("visibilitychange", () => {
    vlog("PAGE", "visibility:", document.visibilityState, "audio:", audioCtx?.state);
  });
})();
