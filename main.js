// ===== Logger =====
const DEBUG = true;
const t = () => new Date().toISOString();
const log = (...a) => DEBUG && console.log(`[main ${t()}]`, ...a);
const warn = (...a) => DEBUG && console.warn(`[main ${t()} WARNING]`, ...a);
const err = (...a) => DEBUG && console.error(`[main ${t()} ERROR]`, ...a);

// ===== Config =====
const MAX_VOICES_PER_NOTE = 8; // prevent infinite stacking on one key
const MAX_TOTAL_VOICES = 64; // global safety cap

// ===== UI =====
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const deviceListEl = document.getElementById("deviceList");
const midiSelectEl = document.getElementById("midiSelect");
const refreshBtn = document.getElementById("refreshBtn");

// sliders / selects
const masterGainEl = document.getElementById("masterGain");
const masterGainVal = document.getElementById("masterGainVal");
const cutoffEl = document.getElementById("cutoff");
const cutoffVal = document.getElementById("cutoffVal");
const resQEl = document.getElementById("resQ");
const resQVal = document.getElementById("resQVal");
const attackEl = document.getElementById("attack");
const attackVal = document.getElementById("attackVal");
const releaseEl = document.getElementById("release");
const releaseVal = document.getElementById("releaseVal");
const waveSelect = document.getElementById("waveSelect");

// ===== Audio graph =====
let audioCtx = null;
let master = null;
// voices now stores a STACK (array) of voices for each MIDI note
/** @type {Map<number, SynthVoice[]>} */
let voices = new Map();

function mtof(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    master = audioCtx.createGain();
    master.gain.value = parseFloat(masterGainEl.value);
    master.connect(audioCtx.destination);
    log("AudioContext created", {
      sampleRate: audioCtx.sampleRate,
      state: audioCtx.state,
    });
  }
}

function forEachVoice(fn) {
  for (const arr of voices.values()) {
    for (const v of arr) fn(v);
  }
}

function setStatus(txt) {
  statusEl.textContent = txt;
  log("STATUS:", txt);
}

function totalVoiceCount() {
  let n = 0;
  for (const arr of voices.values()) n += arr.length;
  return n;
}

// ===== Note handling (STACKED voices per note) =====
function noteOn(note, vel = 100) {
  ensureAudio();

  // Global cap: if exceeded, free the oldest voice across all notes
  if (totalVoiceCount() >= MAX_TOTAL_VOICES) {
    warn("Global voice cap reached; freeing oldest voice.");
    // find oldest by removing from the first non-empty stack we see
    for (const [k, arr] of voices.entries()) {
      const oldest = arr.shift();
      if (oldest) {
        oldest.stop();
        setTimeout(
          () => oldest.dispose(),
          parseFloat(releaseEl.value) * 1000 + 40
        );
        if (arr.length === 0) voices.delete(k);
        break;
      }
    }
  }

  // Create a new voice for EVERY Note On (retrigger behavior)
  const v = new window.SynthVoice(audioCtx, master, {
    type: waveSelect.value,
    attack: parseFloat(attackEl.value),
    release: parseFloat(releaseEl.value),
  });
  v.setFilter(parseFloat(cutoffEl.value), parseFloat(resQEl.value));
  const f = mtof(note);
  v.start(f, vel);

  const stack = voices.get(note) || [];
  stack.push(v);

  // Per-note cap: if exceeded, drop the oldest for this pitch
  if (stack.length > MAX_VOICES_PER_NOTE) {
    const oldest = stack.shift();
    if (oldest) {
      oldest.stop();
      setTimeout(
        () => oldest.dispose(),
        parseFloat(releaseEl.value) * 1000 + 40
      );
      warn(
        `Per-note cap hit on note ${note}; dropped oldest voice. Stack now ${stack.length}.`
      );
    }
  }

  voices.set(note, stack);
  log("noteOn", {
    note,
    freq: f,
    vel,
    perNoteStack: stack.length,
    totalVoices: totalVoiceCount(),
  });
}

function noteOff(note) {
  const stack = voices.get(note);
  if (!stack || stack.length === 0) {
    warn("noteOff with empty stack", { note });
    return;
  }

  // Release the MOST RECENT voice (LIFO)
  const v = stack.pop();
  if (v) {
    v.stop();
    setTimeout(() => v.dispose(), parseFloat(releaseEl.value) * 1000 + 40);
  }

  if (stack.length === 0) voices.delete(note);

  log("noteOff", {
    note,
    remainingForNote: stack ? stack.length : 0,
    totalVoices: totalVoiceCount(),
  });
}

// ===== MIDI parsing =====
function handleMIDIMessage(e) {
  const [status, d1, d2] = e.data;
  const chan = (status & 0x0f) + 1;
  const cmd = status & 0xf0;

  if (cmd === 0x90 && d2 > 0) {
    // Note On
    noteOn(d1, d2);
  } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
    // Note Off or Note On with vel=0
    noteOff(d1);
  } else {
    // other messages (pitch bend, modulation, sustain, etc.)
    // You can add CC handling here if needed.
  }

  log("MIDI msg", {
    raw: Array.from(e.data),
    chan,
    cmd: "0x" + cmd.toString(16),
  });
}

// ===== Device management (native Web MIDI) =====
let midiAccess = null;
let currentInput = null;

function inputsArray() {
  return midiAccess ? Array.from(midiAccess.inputs.values()) : [];
}

function listInputs() {
  const inputs = inputsArray();

  // Visual list
  deviceListEl.innerHTML = "";
  inputs.forEach((inp) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = inp.name || "Unknown device";
    const meta = document.createElement("small");
    meta.textContent = inp.manufacturer ? `by ${inp.manufacturer}` : "";
    li.appendChild(name);
    li.appendChild(meta);
    deviceListEl.appendChild(li);
  });

  // Select dropdown
  midiSelectEl.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = inputs.length ? "Select MIDI Input…" : "No MIDI inputs";
  midiSelectEl.appendChild(ph);

  inputs.forEach((inp) => {
    const opt = document.createElement("option");
    opt.value = inp.id;
    opt.textContent = `${inp.name || `Input ${inp.id}`} (${inp.state})`;
    midiSelectEl.appendChild(opt);
  });

  // Console visibility
  if (inputs.length) {
    console.table(
      inputs.map((i) => ({
        id: i.id,
        name: i.name,
        manufacturer: i.manufacturer,
        state: i.state,
        connection: i.connection,
      }))
    );
  } else {
    warn("No MIDI inputs detected");
  }
}

function attachToInputById(id) {
  if (!midiAccess) return;
  const wanted = inputsArray().find((i) => i.id === id);
  if (!wanted) {
    warn("attachToInputById: not found", id);
    return;
  }

  if (currentInput) {
    currentInput.onmidimessage = null;
    log("Detached previous input", {
      id: currentInput.id,
      name: currentInput.name,
    });
  }
  currentInput = wanted;
  currentInput.onmidimessage = handleMIDIMessage;
  setStatus(`Using: ${currentInput.name || currentInput.id}`);
  log("Attached input", {
    id: currentInput.id,
    name: currentInput.name,
    manufacturer: currentInput.manufacturer,
    state: currentInput.state,
    connection: currentInput.connection,
  });
}

// ===== Optional MIDIengine (from midi-bridge.js) =====
let engine = null;
function tryInitMIDIengine() {
  if (window.MIDIengine) {
    try {
      engine = new window.MIDIengine();
      log("MIDIengine detected and initialized");
      // (Optional) Hook engine callbacks if needed:
      // engine.onNoteOn = (note, vel) => noteOn(note, vel);
      // engine.onNoteOff = (note) => noteOff(note);
    } catch (e) {
      err("Failed to init MIDIengine:", e);
    }
  } else {
    warn("MIDIengine not found; using native Web MIDI");
  }
}

// ===== Init MIDI =====
async function initMIDI() {
  // Environment diagnostics
  log("Location", {
    href: location.href,
    isSecureContext,
    protocol: location.protocol,
  });
  if (!isSecureContext && location.hostname !== "localhost") {
    warn(
      "Web MIDI requires HTTPS or http://localhost. Use a local dev server or HTTPS hosting."
    );
  }

  tryInitMIDIengine();

  if (!navigator.requestMIDIAccess) {
    setStatus("Web MIDI not supported in this browser.");
    err("navigator.requestMIDIAccess is undefined");
    return;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    setStatus("MIDI ready. Choose an input.");

    log("MIDIAccess", {
      inputs: midiAccess.inputs.size,
      outputs: midiAccess.outputs.size,
      sysexEnabled: midiAccess.sysexEnabled,
    });

    listInputs();

    midiAccess.onstatechange = (ev) => {
      const port = ev.port;
      log("MIDI statechange", {
        type: port.type,
        id: port.id,
        name: port.name,
        state: port.state,
        connection: port.connection,
      });
      listInputs();
    };
  } catch (e) {
    setStatus("MIDI access was denied. Check site permissions.");
    err("requestMIDIAccess failed", e);
  }
}

// ===== UI wiring =====
startBtn.addEventListener("click", async () => {
  ensureAudio();
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
    log("AudioContext resumed");
  }
  setStatus("Audio started. Choose a MIDI input and play!");
});

stopBtn.addEventListener("click", async () => {
  if (!audioCtx) return;
  // stop & dispose every voice
  for (const arr of voices.values()) {
    for (const v of arr) {
      v.stop();
      v.dispose();
    }
  }
  voices.clear();
  await audioCtx.suspend();
  log("AudioContext suspended");
  setStatus("Audio suspended.");
});

refreshBtn.addEventListener("click", () => {
  listInputs();
  setStatus("Device list refreshed.");
});

midiSelectEl.addEventListener("change", (e) => {
  const id = e.target.value;
  if (!id) {
    warn("No input selected");
    return;
  }
  attachToInputById(id);
});

// sliders update
function bindRange(input, label, cb, fmt = (v) => v) {
  function update() {
    label.textContent = fmt(input.value);
    cb(parseFloat(input.value));
  }
  input.addEventListener("input", update);
  update();
}

bindRange(
  masterGainEl,
  masterGainVal,
  (v) => {
    if (master) master.gain.value = v;
  },
  (v) => Number(v).toFixed(2)
);
bindRange(cutoffEl, cutoffVal, (v) => {
  for (const arr of voices.values())
    for (const vv of arr) vv.setFilter(v, parseFloat(resQEl.value));
});
bindRange(resQEl, resQVal, (v) => {
  for (const arr of voices.values())
    for (const vv of arr) vv.setFilter(parseFloat(cutoffEl.value), v);
});
bindRange(
  attackEl,
  attackVal,
  (_) => {
    /* applied to new voices */
  },
  (v) => Number(v).toFixed(3)
);
bindRange(
  releaseEl,
  releaseVal,
  (_) => {
    /* applied to new voices */
  },
  (v) => Number(v).toFixed(2)
);

waveSelect.addEventListener("change", () => {
  for (const arr of voices.values())
    for (const v of arr) v.setWave(waveSelect.value);
  log("Waveform changed", waveSelect.value);
});

// DOM ready
window.addEventListener("DOMContentLoaded", initMIDI);
