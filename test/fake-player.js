'use strict';
/**
 * fake-player.js - the tests' stand-in for tvh-player: the same stdin, control pipe (fd 3) and "MGU {json}" events,
 * but it decodes nothing. The mock server's "film" is filler, 20 000 bytes a second (tools/mock-plex.js): this
 * counts the bytes, plays them on a clock that runs FAKE_SPEED times faster than real time, reads no more than 6 s
 * ahead of it (so the pipe's backpressure is real), and says what the real one says: open, decoder, audio, a tick
 * every 50 ms (t: seconds played, state: starting / playing / buffering / paused), end.
 *
 *   FAKE_SPEED (default 20)   FAKE_AUDIO_ERROR=1: the sound is refused   FAKE_CRASH_AT=<s>: exits there, once
 */
const fs = require('fs');
const BPS = 20000, AHEAD = 6;
const speed = Number(process.env.FAKE_SPEED) || 20;
const out = (o) => process.stdout.write('MGU ' + JSON.stringify(o) + '\n');
let bytes = 0, eof = false, t = 0, paused = false, started = false, opened = false, last = Date.now(), gain = 0;

function open() {
    if (opened) return;
    opened = true;
    out({ ev: 'open', video: { codec: 'h264', w: 1280, h: 720, fps: 25, interlaced: false }, audio: { codec: 'aac', rate: 48000, channels: 2 }, duration: 0 });
    out({ ev: 'decoder', ok: true, path: process.env.MGU_VIDEO_PATH || '', w: 1280, h: 720 });
    if (process.env.FAKE_AUDIO_ERROR) out({ ev: 'audio', ok: false, error: 'snd_pcm_open: Operation not permitted' });
    else out({ ev: 'audio', ok: true, device: process.env.MGU_AUDIO || '', codec: 'aac', rate: 48000, channels: 2 });
}
process.stdin.on('data', (d) => {
    bytes += d.length;
    if (bytes > 0) open();
    if (bytes / BPS - t > AHEAD) process.stdin.pause();
});
process.stdin.on('end', () => { eof = true; });
process.stdin.on('error', () => { eof = true; });

let ctl = '';
try {
    const c = fs.createReadStream(null, { fd: 3 });
    c.setEncoding('utf8');
    c.on('data', (d) => {
        ctl += d;
        let i;
        while ((i = ctl.indexOf('\n')) >= 0) {
            const line = ctl.slice(0, i).trim(); ctl = ctl.slice(i + 1);
            if (line === 'pause') paused = true;
            else if (line === 'resume') { paused = false; last = Date.now(); }
            else if (line.indexOf('gain ') === 0) gain = Number(line.slice(5)) || 0;
            else if (line === 'quit') process.exit(0);
        }
    });
    c.on('error', () => {});
} catch (e) { /* no control pipe */ }

setInterval(() => {
    const now = Date.now(), have = bytes / BPS;
    let state = 'starting';
    if (!started && (have >= 1 || (eof && have > 0))) { started = true; last = now; }
    if (started) {
        if (paused) state = 'paused';
        else {
            const want = t + (now - last) / 1000 * speed;
            t = Math.min(want, have);
            state = want > have && !eof ? 'buffering' : 'playing';
        }
    }
    last = now;
    if (opened) out({ ev: 'tick', t: Math.round(t * 1000) / 1000, pos: Math.round(t * 1000) / 1000, state, shown: Math.round(t * 25), late: 0, decerr: 0, buffered: Math.round((have - t) * 10) / 10, gain });
    if (process.env.FAKE_CRASH_AT && t >= Number(process.env.FAKE_CRASH_AT) && !fs.existsSync(process.env.FAKE_CRASH_FLAG || '/nonexistent')) {
        try { fs.writeFileSync(process.env.FAKE_CRASH_FLAG, '1'); } catch (e) { /* no flag: crashes each time */ }
        process.exit(3);
    }
    if (have - t <= AHEAD / 2) process.stdin.resume();
    if (eof && t >= have - 1e-6) { out({ ev: 'end', t, bytes, shown: Math.round(t * 25), late: 0, aplayed: Math.round(t * 47) }); process.exit(0); }
}, 50);
