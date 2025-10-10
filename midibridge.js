// midi-bridge.js (module)
// Loads your ES-module midi.js and exposes MIDIengine globally for classic scripts.

import MIDIengine from "./midi.js"; // path must match the real midi.js location

// Make it available to non-module scripts (main.js expects window.MIDIengine)
window.MIDIengine = MIDIengine;

console.log(
  "[midi-bridge] MIDIengine bridged from ES module to window.MIDIengine"
);
