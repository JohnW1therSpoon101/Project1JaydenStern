//import modules
import MIDIengine from "./midi.js";
import Synth from './synth.js'

console.log("imported midi.js stuff ")
console.log("imported synth.js stuff ")
//create audiocontext
const ctx = new AudioContext();
console.log("created audiocontext"); 

//create masterGain
const masterGain = new GainNode();
console.log("created masterGain"); 

//Assign value to mastergain 
masterGain.gain.value = 0.8;
console.log(masterGain.gain.value); 

//connect gain to audiocontext
masterGain.connect(ctx.destination);
console.log("connected masterGain to audiocontext"); 

//define midiengine
const myMidiStuff = new MIDIengine();

//initiate start
myMidiStuff.onNoteOn = 

//initiate stop
myMidiStuff.offNoteOff = 
