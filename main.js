// main.js (ES Module)
// Hooks UI <-> Synth engine, handles MIDI detection & routing with verbose logging.

import { Synth } from './synth.js';

// ------------- Globals -------------
let ctx = null;
let synth = null;

let midiAccess = null;
let midiInputs = new Map(); // id -> MIDIInput
let currentInputId = null;

const log = (msg, level = 'info') => {
  (level === 'error' ? console.error : console.log)('[Main]', msg);
  if (window.uiLog) window.uiLog(msg, level);
};

// ------------- UI helpers provided by index.html -------------
const UI = window.UI;

// ------------- Audio lifecycle -------------
async function startAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    synth = new Synth(ctx);
  }
  if (ctx.state === 'suspended') await ctx.resume();
  UI.setAudioState(`context: running @ ${ctx.sampleRate} Hz`);
  log('AudioContext started.');
}

async function stopAudio() {
  if (!ctx) return;
  await ctx.suspend();
  UI.setAudioState('context: suspended');
  log('AudioContext suspended.');
}

// ------------- MIDI Detection -------------
async function initMIDI() {
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    log('Web MIDI access granted.');
    midiAccess.onstatechange = handleMIDIStateChange;
    refreshMIDIInputs();
    UI.setMidiStatus('status: ready ✅', true);
  } catch (err) {
    log(`Web MIDI failed: ${err}`, 'error');
    UI.setMidiStatus('status: unavailable ❌', false);
  }
}

function refreshMIDIInputs() {
  midiInputs.clear();
  if (!midiAccess) {
    UI.populateMidiInputs([]);
    UI.setMidiStatus('status: no access', false);
    return;
  }
  for (const input of midiAccess.inputs.values()) {
    const id = input.id;
    midiInputs.set(id, input);
  }
  const items = [...midiInputs.values()].map(i => ({ id: i.id, name: i.name }));
  UI.populateMidiInputs(items);
  UI.setMidiStatus(items.length ? `inputs: ${items.length}` : 'no devices', !!items.length);
  log(`MIDI inputs refreshed (${items.length} device${items.length === 1 ? '' : 's'}).`);
}

function handleMIDIStateChange(e) {
  const port = e.port;
  log(`MIDI ${port.type} "${port.name}" ${port.state} (${port.connection})`);
  refreshMIDIInputs();
  // If selected device disappeared, clear binding
  if (currentInputId && !midiInputs.has(currentInputId)) {
    bindToInput(null);
  }
}

function bindToInput(id) {
  // Unbind previous
  if (currentInputId && midiInputs.has(currentInputId)) {
    midiInputs.get(currentInputId).onmidimessage = null;
  }
  currentInputId = null;

  if (!id || !midiInputs.has(id)) {
    UI.setMidiStatus('status: no device selected', false);
    log('No MIDI device selected.');
    return;
  }

  const input = midiInputs.get(id);
  input.onmidimessage = onMIDIMessage;
  currentInputId = id;
  UI.setMidiStatus(`listening: ${input.name}`, true);
  log(`Bound to MIDI input: ${input.name}`);
}

function onMIDIMessage(e) {
  const [status, data1, data2] = e.data;
  const cmd = status & 0xf0;
  const ch = status & 0x0f;
  const note = data1;
  const vel = data2;

  // 0x90 NoteOn (vel>0), 0x80 NoteOff or NoteOn with vel 0 (running status)
  if (cmd === 0x90 && vel > 0) {
    log(`MIDI NoteOn ch${ch + 1} note=${note} vel=${vel}`);
    if (!synth) return;
    synth.noteOn(note, vel);
  } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
    log(`MIDI NoteOff ch${ch + 1} note=${note}`);
    if (!synth) return;
    synth.noteOff(note);
  } else if (cmd === 0xE0) {
    // Pitch bend (optional)
    const bend = ((data2 << 7) + data1) - 8192; // -8192..+8191
    log(`Pitch bend: ${bend}`, 'info');
  } else {
    // You can expand CC handling here (e.g., mod wheel)
    log(`MIDI msg: [${status.toString(16)} ${data1} ${data2}]`, 'info');
  }
}

// ------------- UI <-> Engine wiring -------------
function onUIAction(e) {
  const { action, value } = e.detail || {};
  switch (action) {
    case 'start-audio':
      startAudio();
      // Kick off MIDI when user starts audio (gesture)
      initMIDI();
      break;
    case 'stop-audio':
      stopAudio();
      break;
    case 'refresh-midi':
      refreshMIDIInputs();
      break;
    case 'select-midi':
      bindToInput(value);
      break;
    default:
      break;
  }
}

function onUIChange(e) {
  if (!synth) return;
  const { id, value } = e.detail || {};
  switch (id) {
    case 'osc-count':        synth.setOscCount(value); break;
    case 'waveform':         synth.setWaveform(value); break;
    case 'mono-mode':        synth.setMono(!!value); break;
    case 'glide':            synth.setGlide(value); break;
    case 'master-gain':      synth.setMasterGain(value); break;

    case 'distortion-drive': synth.setDistortionDrive(value); break;

    // Delay
    case 'delay-mix':        synth.setDelayMix(value); break;
    case 'delay-time':       synth.setDelayTime(value); break;
    case 'delay-feedback':   synth.setDelayFeedback(value); break;

    // Reverb
    case 'reverb-mix':       synth.setReverbMix(value); break;
    case 'reverb-decay':     synth.setReverbDecay(value); break;
    case 'reverb-predelay':  synth.setReverbPreDelay(value); break;

    default:
      break;
  }
}

// ------------- Boot -------------
window.addEventListener('ui-action', onUIAction);
window.addEventListener('ui-change', onUIChange);

// Extra: show a warning if user hits keys before starting audio
document.addEventListener('keydown', (e) => {
  if (!ctx || ctx.state !== 'running') {
    UI.setAudioState('context: tap "Start Audio" ▶ first');
  }
});

// Optional: expose for debugging
window.__synth = () => synth;
window.__midi = () => ({ midiAccess, midiInputs, currentInputId });
log('Main loaded. Click ▶ Start Audio, then choose your MIDI device.');
