// Class: MIDIengine for MUST 4707
// DO NOT EDIT
export default class MIDIengine {
    constructor() {
        // Default no-op handlers
        this.onNoteOff = function () {};
        this.onNoteOn = function () {};
        this.onPolyKeyPressure = function () {};
        this.onControllerChange = function () {};
        this.onProgramChange = function () {};
        this.onChannelPressure = function () {};
        this.onPitchBend = function () {};

        this._midiAccess = null;

        // Request access (secure context + user permission required)
        navigator.requestMIDIAccess()
            .then(this._onMIDISuccess.bind(this), this._onMIDIFailure.bind(this));
    }

    _onMIDISuccess(access) {
        this._midiAccess = access;

        // Hook up all current inputs
        for (const input of access.inputs.values()) {
            input.onmidimessage = this._midiParser.bind(this);
        }

        // Hot-plug device changes (optional)
        access.onstatechange = (e) => {
            // e.port: { type: "input"|"output", state: "connected"|"disconnected", name, id, ... }
            // Rewire new inputs if needed:
            if (e.port.type === "input" && e.port.state === "connected") {
                e.port.onmidimessage = this._midiParser.bind(this);
            }
        };
    }

    _onMIDIFailure(err) {
        console.error("Failed to access MIDI devices.", err);
    }

    _midiParser(event) {
        const data = event.data;             // Uint8Array
        const status = data[0];
        const command = status & 0xF0;       // high nibble
        const channel = status & 0x0F;       // 0–15
        const data1 = data[1];               // may be undefined for some messages
        const data2 = data[2];               // may be undefined for some messages

        switch (command) {
            case 0x80: // Note Off
                this.onNoteOff(data1, data2 ?? 0, channel);
                break;

            case 0x90: // Note On (or Note Off if velocity 0)
                if (data2 && data2 > 0) {
                    this.onNoteOn(data1, data2, channel);
                } else {
                    this.onNoteOff(data1, 0, channel);
                }
                break;

            case 0xA0: // Polyphonic Key Pressure
                this.onPolyKeyPressure(data1, data2 ?? 0, channel);
                break;

            case 0xB0: // Control Change
                this.onControllerChange(data1, data2 ?? 0, channel);
                break;

            case 0xC0: // Program Change (1 data byte)
                this.onProgramChange(data1, channel);
                break;

            case 0xD0: // Channel Pressure (1 data byte)
                this.onChannelPressure(data1, channel);
                break;

            case 0xE0: { // Pitch Bend (14-bit: LSB=data1, MSB=data2)
                const value14 = ((data2 ?? 0) << 7) | (data1 ?? 0); // 0..16383
                const bend = value14 - 8192; // center at 0
                // Pass both signed bend and raw 14-bit value
                this.onPitchBend(bend, channel, value14);
                break;
            }

            default:
                break;
        }
    }
}
