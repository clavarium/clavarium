/* DICTATION IN THE PAGE: the microphone stays open, each spoken phrase is
   transcribed and handed to whoever listens. The page types it into the
   terminal. See voice-core.js for how a phrase is found. */
import { RATE, BLOCK, BLOCK_MS, Detector, Segmenter, loudness, toWav } from './voice-core.js';

/* The operator's pages ask /api, a paired device asks /c/api. */
const API = document.documentElement.dataset.door === 'device' ? '/c/api' : '/api';

/* Opens the microphone; resolves with a function that closes it.
   `on.phrase(text)`, `on.state(word)`: calibrating, listening, hearing,
   transcribing; `on.error(message)`. */
async function listen(on) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    const context = new (window.AudioContext ?? window.webkitAudioContext)({ sampleRate: RATE });
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(BLOCK, 1, 1);
    const detector = new Detector();
    let pending = 0;
    let closed = false;
    const tell = () => { if (!closed) on.state(pending > 0 ? 'transcribing' : segmenter.speaking ? 'hearing' : detector.ready() ? 'listening' : 'calibrating'); };
    const segmenter = new Segmenter({
        onStart: () => { on.speech?.(); tell(); },
        onPhrase: async (blocks) => {
            pending++; tell();
            try {
                const r = await fetch(`${API}/voice`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: toWav(blocks) });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error || 'The phrase could not be transcribed.');
                if (!closed && j.text) on.phrase(j.text);
            } catch (error) { if (!closed) on.error(error.message); }
            pending--; tell();
        },
    });
    let count = 0;
    node.onaudioprocess = (event) => {
        const samples = Float32Array.from(event.inputBuffer.getChannelData(0));
        const was = segmenter.speaking;
        segmenter.feed(detector.hear(loudness(samples)), count++ * BLOCK_MS, samples);
        if (was !== segmenter.speaking || count === 33) tell();
    };
    source.connect(node); node.connect(context.destination);
    tell();
    return () => {
        closed = true;
        node.onaudioprocess = null; node.disconnect(); source.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void context.close();
    };
}

window.clavariumVoice = {
    available: async () => { try { const r = await fetch(`${API}/voice`); return r.ok && (await r.json()).available === true; } catch { return false; } },
    listen,
};
window.dispatchEvent(new Event('clavarium-voice-ready'));
