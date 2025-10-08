// main.js
import { Synth } from "./synth.js";

// ---------- Global state ----------
let ctx = null;
let master = null;
let midi = null;
const voices = new Map(); // midiNote -> Synth
let midiInitialized = false;

// ---------- UI elements ----------
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const inputsEl = document.getElementById("inputs");

const masterGainEl = document.getElementById("masterGain");
const masterGainValEl = document.getElementById("masterGainVal");
const cutoffEl = document.getElementById("cutoff");
const cutoffValEl = document.getElementById("cutoffVal");
const resEl = document.getElementById("resonance");
const resValEl = document.getElementById("resVal");

// ---------- Helpers ----------
function updateMasterGain() {
  if (!ctx || !master) return;
  const val = Number(masterGainEl.value);
  master.gain.setTargetAtTime(val, ctx.currentTime, 0.01);
  masterGainValEl.textContent = val.toFixed(2);
}

function updateFilter() {
  const cutoffHz = Number(cutoffEl.value);
  const q = Number(resEl.value);
  cutoffValEl.textContent = `${cutoffHz} Hz`;
  resValEl.textContent = q.toString();

  // Push to all active voices
  for (const synth of voices.values()) {
    synth.setFilter(cutoffHz, q);
  }
}

function listInputsIfAvailable() {
  try {
    const list =
      midi?.inputs?.map(
        (i) =>
          `${i.name || "Input"}${i.manufacturer ? ` (${i.manufacturer})` : ""}`
      ) || [];
    inputsEl.textContent = list.length ? list.join(", ") : "No inputs detected";
  } catch {
    inputsEl.textContent = "No inputs detected";
  }
}

function stopAllVoices() {
  if (!ctx) return;
  for (const [note, v] of voices.entries()) {
    try {
      v.stop(ctx.currentTime);
    } catch {}
    voices.delete(note);
  }
  statusEl.textContent = `All voices stopped. (voices: 0)`;
}

function guardIfSuspended() {
  // Ignore note handling if audio is not running
  return !ctx || ctx.state !== "running";
}

// ---------- Initial UI readouts ----------
masterGainValEl.textContent = Number(masterGainEl.value).toFixed(2);
cutoffValEl.textContent = `${cutoffEl.value} Hz`;
resValEl.textContent = resEl.value;

// Live control handlers
masterGainEl.addEventListener("input", updateMasterGain);
cutoffEl.addEventListener("input", updateFilter);
resEl.addEventListener("input", updateFilter);

// ---------- Start / Stop logic ----------
startBtn.addEventListener("click", async () => {
  // Create (once) and/or resume the AudioContext
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });
    master = ctx.createGain();
    master.gain.value = Number(masterGainEl.value);
    master.connect(ctx.destination);
  }

  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  // Update buttons early for UX
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = "Audio running. Initializing MIDI…";

  // Initialize MIDI (only once)
  if (!midiInitialized) {
    try {
      // midi.js provided helper (do not modify midi.js)
      midi = new MIDIengine();

      // Attach callbacks
      midi.onNoteOn = (note, velocity) => {
        if (guardIfSuspended()) return;

        // Some devices send NoteOn with vel=0 as NoteOff; handle gracefully
        if (velocity === 0) {
          const v = voices.get(note);
          if (v) {
            v.stop(ctx.currentTime);
            voices.delete(note);
            statusEl.textContent = `NoteOff (via vel=0): ${note} (voices: ${voices.size})`;
          }
          return;
        }

        // Retrigger behavior: if note is already active, stop then replace
        const existing = voices.get(note);
        if (existing) {
          existing.stop(ctx.currentTime);
          voices.delete(note);
        }

        const synth = new Synth(ctx, master, {
          wave: "sawtooth",
          cutoff: Number(cutoffEl.value),
          q: Number(resEl.value),
          a: 0.01,
          d: 0.12,
          s: 0.6,
          r: 0.2,
        });

        synth.start(note, velocity, ctx.currentTime);
        voices.set(note, synth);
        statusEl.textContent = `NoteOn: ${note} vel=${velocity} (voices: ${voices.size})`;
      };

      midi.onNoteOff = (note) => {
        if (guardIfSuspended()) return;

        const v = voices.get(note);
        if (v) {
          v.stop(ctx.currentTime);
          voices.delete(note);
        }
        statusEl.textContent = `NoteOff: ${note} (voices: ${voices.size})`;
      };

      // Optional: reflect inputs
      listInputsIfAvailable();

      midiInitialized = true;
      statusEl.textContent = "MIDI ready. Play your controller!";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "MIDI failed to initialize. See console.";
    }
  } else {
    // Already initialized, just ready to play again
    listInputsIfAvailable();
    statusEl.textContent = "Audio running. MIDI active.";
  }

  // Ensure current slider values are applied
  updateMasterGain();
  updateFilter();
});

stopBtn.addEventListener("click", async () => {
  if (ctx && ctx.state === "running") {
    // Release all voices for a clean stop
    stopAllVoices();

    await ctx.suspend();
    statusEl.textContent = "Audio suspended. MIDI input paused.";
    stopBtn.disabled = true;
    startBtn.disabled = false;
  }
});
