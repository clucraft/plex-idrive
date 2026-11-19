'use strict';
/**
 * Tests of the Drive-In app and its service. No car, no Plex account and no network are needed:
 *
 *   node test/run.js                      on this computer's Node
 *   node tools/node8.js test/run.js       on Node 8, as the head unit runs both
 *
 * - the pieces: the HLS playlist reader, the Plex answers' mapping, the drive gate and the passenger disclaimer's
 *   consent, the posters' scaling, the texts
 * - the service (native/clucraft-plex) against a stand-in plex.tv and server (tools/mock-plex.js), with a stand-in
 *   player (test/fake-player.js): signing in with a link code, the library, playing, pausing, skipping, the end, the
 *   next episode, a stream that breaks, a server that refuses, the app going away
 * - the app's store and pages (tools/stage.js): every page drawn, taps on its targets, the picture off while driving
 * - main.js on a stand-in head unit, from the package the kit's build stages (needs Python 3; skipped without)
 * - the repository: versions and manifests agree
 *
 * What these cannot say is listed in the README ("What still needs a car"): the real player on the real GPU and
 * speakers, and a real Plex server's transcoder.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'clucraft_plex');
const SVC = path.join(ROOT, 'native', 'clucraft-plex');
const { createStage, sleep } = require(path.join(ROOT, 'tools', 'stage'));
const { createMock, TOKEN } = require(path.join(ROOT, 'tools', 'mock-plex'));

// the service logs to the console: kept out of the tests' own lines (TEST_LOG=1 shows it)
const print = console.log.bind(console);
if (!process.env.TEST_LOG) console.log = () => {};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, (what || 'value') + ' ' + a + ' is not within ' + eps + ' of ' + b);

/* ---------------- the pieces ---------------- */

test('hls: a master playlist names its stream, a media playlist its segments', () => {
    const { parsePlaylist } = require(path.join(SVC, 'hls'));
    const m = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4000000,RESOLUTION=1280x720\nsession/abc/base/index.m3u8\n');
    assert.deepStrictEqual(m.master, ['session/abc/base/index.m3u8']);
    assert.strictEqual(m.segments.length, 0);
    const p = parsePlaylist('#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXT-X-TARGETDURATION:4\r\n#EXT-X-MEDIA-SEQUENCE:7\r\n#EXTINF:4.000,\r\n00007.ts\r\n#EXTINF:2.5,\r\n00008.ts\r\n');
    assert.deepStrictEqual(p.segments, [{ uri: '00007.ts', dur: 4 }, { uri: '00008.ts', dur: 2.5 }]);
    assert.strictEqual(p.endlist, false); assert.strictEqual(p.target, 4); assert.strictEqual(p.sequence, 7);
    assert.strictEqual(parsePlaylist(p.segments.map((s) => '#EXTINF:' + s.dur + ',\n' + s.uri).join('\n') + '\n#EXT-X-ENDLIST').endlist, true);
});

test('hls: reading starts at the segment that holds the offset when the list is the whole film, else at its first', () => {
    const { startAt } = require(path.join(SVC, 'hls'));
    const segs = Array.from({ length: 30 }, () => ({ uri: 'x', dur: 4 }));       // 120 s
    assert.deepStrictEqual(startAt(segs, 50, 120), { index: 12, base: 48, mode: 'seek', seconds: 120 });
    assert.deepStrictEqual(startAt(segs, 0, 120), { index: 0, base: 0, mode: 'offset', seconds: 120 });
    // the list is only what follows the offset (120 s of a 600 s film asked for at 480 s)
    assert.deepStrictEqual(startAt(segs, 480, 600), { index: 0, base: 480, mode: 'offset', seconds: 120 });
    assert.strictEqual(startAt(segs, 119.9, 120).index, 29);
});

test('plex: an item and its tracks as the app gets them; the token is never in an address', () => {
    const { createPlex, view, mediaOf } = require(path.join(SVC, 'plex'));
    const it = view({ ratingKey: 7, type: 'episode', title: 'Pilot', duration: 2520000, viewOffset: 61000, index: 1, parentIndex: 2, parentRatingKey: 5, parentTitle: 'Season 2',
        grandparentRatingKey: 3, grandparentTitle: 'A Show', audienceRating: 8.25, originallyAvailableAt: '2020-03-01' });
    assert.deepStrictEqual([it.key, it.duration, it.viewOffset, it.year, it.parentKey, it.grandparentKey, it.rating], ['7', 2520, 61, 2020, '5', '3', 8.3]);
    assert.strictEqual(view({ title: 'no key' }), null);
    const md = mediaOf({ Media: [{ id: 1, videoResolution: '1080', videoCodec: 'hevc', Part: [{ id: 9, Stream: [{ id: 1, streamType: 1, bitDepth: 10 },
        { id: 2, streamType: 2, displayTitle: 'English (AC3 5.1)', selected: true }, { id: 3, streamType: 3, displayTitle: 'English (SRT)' }] }] }] });
    assert.deepStrictEqual([md[0].partId, md[0].bitDepth, md[0].audio[0].selected, md[0].subtitles[0].name], ['9', 10, true, 'English (SRT)']);
    const px = createPlex({ nx: {}, device: { id: 'x' } });
    px.use({ uri: 'https://example.plex.direct:32400/', token: 'SECRET-TOKEN' });
    const args = px.transcodeArgs({ key: '7', offset: 61.7, quality: '720', session: 's1', sid: 'c1' });
    const u = px.masterUrl(args);
    assert.ok(u.indexOf('https://example.plex.direct:32400/video/:/transcode/universal/start.m3u8?') === 0, u);
    assert.ok(u.indexOf('SECRET') < 0 && u.indexOf('X-Plex-Token') < 0, 'the token is in the address');
    assert.strictEqual(px.headers()['X-Plex-Token'], 'SECRET-TOKEN');
    assert.deepStrictEqual([args.offset, args.protocol, args.maxVideoBitrate, args.videoResolution, args.subtitles, args.directPlay], [61, 'hls', 4000, '1280x720', 'none', 0]);
    assert.strictEqual(px.transcodeArgs({ key: '7', quality: 'nonsense', session: 's', sid: 'c' }).maxVideoBitrate, 4000);
});

test('drive gate: parked only on a fresh speed under 1 km/h with the selector in P; anything unknown is not parked', () => {
    const DG = require(path.join(APP, 'drivegate'));
    let t = 1000000;
    const g = DG.createGate({ now: () => t });
    assert.strictEqual(g.parked(), false, 'nothing known');
    g.stage('P');
    assert.strictEqual(g.parked(), false, 'no speed yet');
    g.speed({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(g.parked(), true);
    g.speed({ speedVehicleCentreOfGravity: 65535 });             // "no value": the last real one stays, and ages
    assert.strictEqual(g.parked(), true);
    t += DG.STALE_MS + 1;
    assert.strictEqual(g.parked(), false, 'a speed that stopped arriving');
    g.speed({ speedVehicleCentreOfGravity: 64 * 30 });           // 30 km/h
    assert.strictEqual(g.parked(), false);
    assert.ok(/30\.0 km\/h/.test(g.why()), g.why());
    g.speed({ speedVehicleCentreOfGravity: 20 });                 // 0.3 km/h, but in D: a red light
    g.stage('D');
    assert.strictEqual(g.parked(), false, 'standing in D');
    g.stage('NP');
    assert.strictEqual(g.parked(), true, 'N or P, standing');
    g.speed({ speedVehicleCentreOfGravity: 64 * 3 });
    assert.strictEqual(g.parked(), false, 'N or P, rolling');
    assert.deepStrictEqual([DG.stageFromGearbox({ statusActualStageDrive: 1 }), DG.stageFromGearbox({ statusActualStageDrive: 'D' }), DG.stageFromGearbox({}),
        DG.stageFromSelection({ statusGearSelectionDrive: 3 }), DG.stageFromSelection({ statusGearSelectionDrive: 4 }), DG.stageFromSelection({ statusGearSelectionDrive: 2 })],
    ['P', 'D', undefined, 'P', 'NP', '2']);
    // a gate nothing feeds (no signals on this unit): never parked, and watch() does not throw
    assert.strictEqual(DG.watch(null, null, DG.createGate()).parked(), false);
});

test('drive gate: the picture while driving needs the setting AND the accepted disclaimer', () => {
    const DG = require(path.join(APP, 'drivegate'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const consent = DG.createConsent(path.join(dir, 'passenger.json'));
    const driving = DG.createGate(), parked = DG.createGate();
    driving.speed({ speedVehicleCentreOfGravity: 64 * 50 }); driving.stage('D');
    parked.speed({ speedVehicleCentreOfGravity: 0 }); parked.stage('P');
    assert.strictEqual(DG.pictureAllowed(parked, false, consent), true, 'parked');
    assert.strictEqual(DG.pictureAllowed(driving, false, consent), false, 'driving, setting off');
    assert.strictEqual(DG.pictureAllowed(driving, true, consent), false, 'driving, the setting on but the disclaimer not accepted');
    assert.strictEqual(consent.accept(), true);
    assert.strictEqual(DG.pictureAllowed(driving, false, consent), false, 'driving, the disclaimer accepted but the setting off');
    assert.strictEqual(DG.pictureAllowed(driving, true, consent), true, 'driving, both');
    assert.strictEqual(DG.pictureAllowed(driving, 'true', consent), false, 'the setting must be the boolean');
    // kept across a restart, gone when cleared, and only for the text it was given for
    assert.strictEqual(DG.createConsent(path.join(dir, 'passenger.json')).given(), true);
    consent.clear();
    assert.strictEqual(DG.pictureAllowed(driving, true, consent), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'passenger.json')), false);
    fs.writeFileSync(path.join(dir, 'passenger.json'), JSON.stringify({ accepted: true, version: DG.DISCLAIMER_VERSION + 1 }));
    assert.strictEqual(DG.createConsent(path.join(dir, 'passenger.json')).given(), false, 'another version of the text');
    // a gate that throws, a consent that throws: no picture
    assert.strictEqual(DG.pictureAllowed({ parked() { throw new Error('x'); } }, true, { given() { throw new Error('y'); } }), false);
    // a consent that cannot be written is not given
    assert.strictEqual(DG.createConsent(path.join(dir, 'no-such-folder', 'p.json')).accept(), false);
    assert.ok(DG.DISCLAIMER.join(' ').length > 300 && /passenger/.test(DG.DISCLAIMER[0]));
});

test('posters: a JPEG becomes exactly the pixels asked for, opaque', () => {
    const { cover } = require(path.join(SVC, 'art'));
    const jpg = fs.readFileSync(path.join(ROOT, 'tools', 'mock', 'posters', '01.jpg'));
    const px = cover(jpg, 148, 222);
    assert.strictEqual(px.length, 148 * 222 * 4);
    for (let i = 3; i < px.length; i += 4 * 97) assert.strictEqual(px[i], 255);
    assert.ok(px[0] + px[1] + px[2] > 30, 'the first pixel is not black');
    assert.strictEqual(cover(jpg, 300, 100).length, 300 * 100 * 4);       // another shape: cropped, not squeezed
    assert.throws(() => cover(Buffer.from('not a picture'), 10, 10), /not a JPEG/);
});

test('texts: times, and titles in letters the app\'s font has', () => {
    const U = require(path.join(APP, 'ui'));
    assert.deepStrictEqual([U.hms(0), U.hms(65), U.hms(3725), U.dur(2520), U.dur(5760), U.dur(7200)], ['0:00', '1:05', '1:02:05', '42 min', '1 h 36 min', '2 h ']);
    assert.strictEqual(U.clean('Amélie – Łódź 日本 “quoted”'), 'Amélie – Lódz  “quoted”');
    assert.strictEqual(U.epTag({ parentIndex: 2, index: 5 }), 'S2 E5');
});

test('player: a stream\'s bytes that arrive before its start are kept, an old stream\'s are dropped', async () => {
    const { createPlayer } = require(path.join(SVC, 'player'));
    const { PassThrough } = require('stream');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'player-'));
    const events = [];
    const pl = createPlayer({ bin: process.execPath, args: [path.join(ROOT, 'test', 'fake-player.js')], cwd: tmp, uid: null, videoPath: path.join(tmp, 'v'), env: { FAKE_SPEED: '200' },
        onEvent: (id, ev) => { if (ev.ev === 'end') events.push([id, ev.bytes]); } });
    const pipe = new PassThrough();
    pl.attach(pipe);
    const frame = (id, b) => { const h = Buffer.alloc(8); h.writeUInt32LE(id, 0); h.writeUInt32LE(b === null ? 0xffffffff : b.length, 4); return b === null ? h : Buffer.concat([h, b]); };
    // stream 1's bytes and its end, all before "start 1" is told
    pipe.write(frame(1, Buffer.alloc(30000, 1)));
    pipe.write(frame(1, Buffer.alloc(30000, 2)));
    pipe.write(frame(1, null));
    await sleep(50);
    pl.start(1);
    for (let i = 0; i < 100 && !events.length; i++) await sleep(50);
    assert.deepStrictEqual(events, [[1, 60000]]);
    // stream 3 is started; bytes still coming of stream 2 (left) are dropped, stream 3's are played
    pl.start(3);
    pipe.write(frame(2, Buffer.alloc(50000, 3)));
    pipe.write(frame(3, Buffer.alloc(40000, 4)));
    pipe.write(frame(3, null));
    for (let i = 0; i < 100 && events.length < 2; i++) await sleep(50);
    assert.deepStrictEqual(events[1], [3, 40000]);
    await pl.stopAll();
});

/* ---------------- the service ---------------- */

test('car audio: a route that fails is tried again at its own pace, not on every poll of the app, and said once', async () => {
    const { createCarAudio } = require(path.join(ROOT, 'apps', 'clucraft_plex', 'caraudio'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drivein-audio-'));
    let up = false, tries = 0, conns = [];
    const signals = {
        proxy: async (iface) => { if (!up) { tries++; throw new Error('no audio manager'); } return { iface }; },
        call: async (p, m, a) => {
            if (m === 'getListMainConnections') return conns.slice();
            if (m === 'connect') { conns.push({ mainConnectionID: 7, sourceID: a.sourceID, sinkID: a.sinkID }); return { amError: 'E_OK', mainConnectionID: 7 }; }
            if (m === 'disconnect') { conns = conns.filter((c) => c.mainConnectionID !== a.mainConnectionID); return { amError: 'E_OK' }; }
            return {};
        },
    };
    const said = [], log = { info: (s) => said.push('i ' + s), warn: (s) => said.push('w ' + s) };
    const au = createCarAudio(signals, log, path.join(tmp, 'audio.json'), { retryMs: 120 });
    // the app asks after every answer of the service, a few times a second
    for (let i = 0; i < 25; i++) { au.want(true); await sleep(4); }
    assert.strictEqual(tries, 1, 'one attempt for 25 polls, not ' + tries);
    await sleep(420);
    assert.ok(tries >= 3 && tries <= 5, 'tried again every 120 ms: ' + tries);
    assert.deepStrictEqual(said.filter((s) => s[0] === 'w'), ['w car audio: no audio manager'], 'the same failure is logged once');
    assert.strictEqual(au.state().error, 'no audio manager');
    up = true;
    await sleep(300);
    assert.deepStrictEqual([au.state().connected, au.state().error, conns.length], [true, null, 1]);
    for (let i = 0; i < 10; i++) { au.want(true); await sleep(4); }
    assert.strictEqual(conns.length, 1, 'connected once');
    au.want(false);
    await sleep(80);
    assert.deepStrictEqual([au.state().connected, conns.length], [false, 0]);
});

async function linked(o) {
    const st = await createStage(Object.assign({ linked: false, filmSeconds: 40 }, o || {}));
    const cmd = (m) => st.svc.command(m);
    await cmd({ cmd: 'link-start' });
    let s = await st.until(() => st.S.st && st.S.st.link && st.S.st.link.code, 5000, 'the code');
    st.mock.link();
    await st.until(() => st.S.connected(), 10000, 'the server');
    return { st, cmd, code: s };
}
const playing = (st) => st.until(() => st.S.pb() && st.S.pb().state === 'playing', 10000, 'playing');

test('service: signing in with a link code; the token stays in a 0600 file and out of every answer', async () => {
    const st = await createStage({ linked: false });
    const cmd = (m) => st.svc.command(m);
    let s = await cmd({ cmd: 'status' });
    assert.strictEqual(s.account, null); assert.strictEqual(s.client.state, 'signed-out');
    await cmd({ cmd: 'link-start' });
    await st.until(() => st.S.st.link && st.S.st.link.code, 5000, 'the code');
    assert.ok(/^[A-Z0-9]{4}$/.test(st.S.st.link.code), st.S.st.link.code);
    assert.ok(st.S.st.link.expires > Date.now() + 60000);
    assert.strictEqual(st.S.signedIn(), false, 'not signed in before the code is used');
    st.mock.link();
    await st.until(() => st.S.connected(), 10000, 'connected');
    s = await cmd({ cmd: 'status' });
    assert.deepStrictEqual([s.account.user, s.client.server.name, s.client.server.relay, s.client.servers.length], ['Driver', 'Jupiter', false, 2]);
    const f = path.join(st.tmp, 'state', 'account.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).token, TOKEN);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    const all = JSON.stringify([s, await cmd({ cmd: 'home' }), await cmd({ cmd: 'meta', key: '101' })]);
    assert.ok(all.indexOf(TOKEN) < 0 && all.indexOf('mock-') < 0, 'a token in an answer to the app');
    // signing out deletes it
    await cmd({ cmd: 'signout' });
    assert.strictEqual(fs.existsSync(f), false);
    assert.strictEqual((await cmd({ cmd: 'status' })).account, null);
    await st.close();
});

test('service: the library, a show\'s seasons and episodes, search, a poster made once', async () => {
    const { st, cmd } = await linked();
    const home = await cmd({ cmd: 'home' });
    assert.deepStrictEqual(home.sections.map((x) => x.title + ':' + x.type), ['Movies:movie', 'TV Shows:show']);     // (the music library is left out)
    assert.ok(home.deck.length >= 2 && home.recent.length > 5);
    const a = await cmd({ cmd: 'section', key: '1', type: 'movie', sort: 'title', start: 0, size: 5 });
    assert.strictEqual(a.total, 14); assert.strictEqual(a.items.length, 5);
    const b = await cmd({ cmd: 'section', key: '1', type: 'movie', sort: 'title', start: 10, size: 5 });
    assert.strictEqual(b.items.length, 4);
    assert.ok((await cmd({ cmd: 'section', key: '1', type: 'movie', unwatched: true })).total < 14);
    const shows = await cmd({ cmd: 'section', key: '2', type: 'show' });
    const hl = shows.items.filter((x) => x.title === 'Harbor Lights')[0];
    const seasons = await cmd({ cmd: 'children', key: hl.key });
    assert.deepStrictEqual(seasons.items.map((x) => x.type + x.index), ['season1', 'season2']);
    const eps = await cmd({ cmd: 'children', key: seasons.items[0].key });
    assert.strictEqual(eps.items.length, 8); assert.strictEqual(eps.items[3].type, 'episode');
    assert.deepStrictEqual((await cmd({ cmd: 'search', q: 'light' })).items.map((x) => x.type + ':' + x.title), ['movie:Half Light', 'show:Harbor Lights']);
    const m = (await cmd({ cmd: 'meta', key: a.items[0].key })).item;
    assert.ok(m.media[0].audio.length === 2 && m.media[0].subtitles.length === 1 && m.summary.length > 20);
    const before = st.mock.state.requests;
    const p1 = await cmd({ cmd: 'art', path: m.thumb, w: 148, h: 222 });
    assert.strictEqual(Buffer.from(p1.img, 'base64').length, 148 * 222 * 4);
    const mid = st.mock.state.requests;
    const p2 = await cmd({ cmd: 'art', path: m.thumb, w: 148, h: 222 });
    assert.strictEqual(p2.img, p1.img);
    assert.ok(mid > before && st.mock.state.requests === mid, 'the second one asked the server again');
    assert.strictEqual((await cmd({ cmd: 'art', path: 'http://elsewhere/x.jpg', w: 148, h: 222 })).none, true);
    assert.strictEqual((await cmd({ cmd: 'meta', key: '99999' })).item, null);
    await cmd({ cmd: 'watched', key: m.key, on: true });
    assert.strictEqual(st.mock.state.scrobbled[m.key], true);
    await cmd({ cmd: 'streams', part: m.media[0].partId, subtitle: m.media[0].subtitles[0].id });
    assert.deepStrictEqual(st.mock.state.streams[0], { part: m.media[0].partId, audio: null, subtitle: m.media[0].subtitles[0].id });
    await st.close();
});

test('service: a film plays from where it was, pauses, skips and ends; the server is told', async () => {
    const { st, cmd } = await linked();
    await cmd({ cmd: 'prefs', gain: 9 });
    await cmd({ cmd: 'play', key: '102', offset: 24, quality: '720' });
    await playing(st);
    let p = st.S.pb();
    assert.deepStrictEqual([p.item.title, p.duration, p.quality, p.how, p.gain], ['Night Freight', 40, '720', 'transcode', 9]);
    near(p.pos, 24, 6, 'the start');
    const sess = Object.keys(st.mock.state.sessions)[0], first = st.mock.state.sessions[sess];
    assert.strictEqual(Number(first.args.offset), 24);
    assert.strictEqual(first.segments[0], 12, 'the first segment read is the one that holds 24 s');
    assert.ok(/add-limitation/.test(first.args['X-Plex-Client-Profile-Extra']) && first.args.directPlay === '0');
    await cmd({ cmd: 'pause' });
    await st.until(() => st.S.pb().state === 'paused', 3000, 'paused');
    const at = st.S.pb().pos;
    await st.settle(400);
    near(st.S.pb().pos, at, 0.5, 'paused: the film stands');
    await cmd({ cmd: 'resume' });
    await playing(st);
    await cmd({ cmd: 'seek', pos: 6 });
    await st.until(() => st.S.pb().state === 'playing' && st.S.pb().pos < 20, 8000, 'the skip');
    assert.ok(st.mock.state.stopped.indexOf(sess) >= 0, 'the first transcode was not stopped');
    assert.strictEqual(Object.keys(st.mock.state.sessions).length, 1);
    await st.until(() => st.S.pb().state === 'ended', 10000, 'the end');
    assert.strictEqual(st.S.pb().pos, 40);
    // every byte of the stream reached the player: from the segment that holds 6 s (the fourth) to the last of 20
    const ends = st.S.st.log.map((l) => /"ev":"end".*"bytes":(\d+)/.exec(l)).filter(Boolean);
    assert.strictEqual(Number(ends[ends.length - 1][1]), 17 * 2 * 20000, 'the player did not get the whole stream');
    const tl = st.mock.state.timeline, last = tl[tl.length - 1];
    assert.deepStrictEqual([last.key, last.state, last.time], ['102', 'stopped', 40000]);
    assert.ok(tl.some((x) => x.state === 'paused') && tl.some((x) => x.state === 'playing'));
    assert.strictEqual(Object.keys(st.mock.state.sessions).length, 0, 'a transcode left running on the server');
    await st.close();
});

test('service: a server whose playlist starts at the offset plays from there too', async () => {
    const { st, cmd } = await linked({ mock: { whole: false } });
    await cmd({ cmd: 'play', key: '102', offset: 24 });
    await playing(st);
    near(st.S.pb().pos, 24, 6, 'the start');
    const s = st.mock.state.sessions[Object.keys(st.mock.state.sessions)[0]];
    assert.strictEqual(s.segments[0], 12);
    await st.until(() => st.S.pb().state === 'ended', 10000, 'the end');
    await st.close();
});

test('service: an episode knows the next one, across a season\'s end', async () => {
    const { st, cmd } = await linked();
    const shows = await cmd({ cmd: 'section', key: '2', type: 'show' });
    const seasons = (await cmd({ cmd: 'children', key: shows.items.filter((x) => x.title === 'Harbor Lights')[0].key })).items;
    const s1 = (await cmd({ cmd: 'children', key: seasons[0].key })).items, s2 = (await cmd({ cmd: 'children', key: seasons[1].key })).items;
    await cmd({ cmd: 'play', key: s1[2].key, offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().next, 8000, 'the next episode');
    assert.strictEqual(st.S.pb().next.key, s1[3].key);
    await cmd({ cmd: 'play', key: s1[s1.length - 1].key, offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().item && st.S.pb().item.key === s1[s1.length - 1].key && st.S.pb().next, 8000, 'the next season');
    assert.strictEqual(st.S.pb().next.key, s2[0].key);
    await cmd({ cmd: 'play', key: s2[s2.length - 1].key, offset: 0 });
    await playing(st);
    await st.settle(300);
    assert.strictEqual(st.S.pb().next, null, 'the last episode of the last season has no next');
    await cmd({ cmd: 'stop' });
    await st.until(() => st.S.pb().state === 'idle', 3000, 'stopped');
    await st.close();
});

test('service: a segment that fails is read again; a session the server dropped is started again where the film was', async () => {
    let fails = 0, dropped = false;
    const gone = {};
    const { st, cmd } = await linked({ retryForMs: 4000, mock: { segmentFail: (n, s) => {
        if (n === 3 && fails < 2) { fails++; return 500; }                           // twice, then fine
        // segment 9: the session that first asks for it is gone for good (404), as a server that dropped a transcode
        if (n === 9 && (!dropped || gone[s.args.session])) { dropped = true; gone[s.args.session] = true; return 404; }
        return 0;
    } } });
    await cmd({ cmd: 'play', key: '102', offset: 0 });
    await st.until(() => st.S.pb().state === 'ended', 20000, 'the end');
    assert.strictEqual(fails, 2);
    assert.strictEqual(dropped, true);
    assert.ok(st.mock.state.decisions >= 2, 'no second transcode was started');
    assert.ok(st.S.st.log.some((l) => /again from \d+ s/.test(l)), st.S.st.log.join('\n'));
    assert.strictEqual(st.S.pb().pos, 40);
    await st.close();
});

test('service: a film the server refuses says why; a film that keeps failing gives up', async () => {
    const { st, cmd } = await linked({ retryForMs: 300, mock: { refuse: 'Not enough bandwidth for any playback of this item' } });
    await cmd({ cmd: 'play', key: '102', offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().state === 'error', 5000, 'the refusal');
    assert.ok(/Not enough bandwidth/.test(st.S.pb().error), st.S.pb().error);
    st.mock.options.refuse = null;
    st.mock.options.segmentFail = () => 404;
    await cmd({ cmd: 'play', key: '103', offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().item && st.S.pb().item.key === '103' && st.S.pb().state === 'error', 20000, 'giving up');
    assert.ok(st.mock.state.decisions >= 4, 'it was not tried again');
    await st.close();
});

test('service: a sign-in Plex no longer accepts leads back to signing in', async () => {
    const mock = await createMock({ linked: true });
    // a service that starts with a token plex.tv refuses
    const { createService } = require(path.join(SVC, 'service'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-'));
    fs.mkdirSync(path.join(tmp, 'state'));
    fs.writeFileSync(path.join(tmp, 'state', 'account.json'), JSON.stringify({ token: 'an-old-token' }));
    const svc = createService({ stateDir: path.join(tmp, 'state'), uid: null, exit: false, leasePath: path.join(tmp, 'lease.json'),
        childEnv: { PLEXD_TV: mock.url, PLEXD_SYSTEM_DNS: '1', PLEXD_RETRY_MS: '100' }, playerBin: process.execPath, playerArgs: [path.join(ROOT, 'test', 'fake-player.js')], playerCwd: tmp });
    svc.start();
    let s = null;
    for (let i = 0; i < 100 && !(s && s.client.state === 'refused'); i++) { await sleep(50); s = await svc.command({ cmd: 'status' }); }
    assert.strictEqual(s.client.state, 'refused');
    assert.ok(/sign in again/.test(s.client.error), s.client.error);
    assert.ok((await svc.command({ cmd: 'home' })).error, 'the library was answered without a sign-in');
    svc.stop(0); await mock.close(); await sleep(100);
});

test('service: the film stops when the app stops asking (it was closed, or crashed)', async () => {
    const { st, cmd } = await linked({ filmSeconds: 4000, speed: 1, service: { watchMs: 600 } });
    await cmd({ cmd: 'play', key: '102', offset: 0 });
    await playing(st);
    await sleep(1500);                                   // nobody asks
    const s = await cmd({ cmd: 'status' });
    assert.ok(!s.playback || s.playback.state === 'idle', 'still ' + JSON.stringify(s.playback && s.playback.state));
    assert.ok(s.log.some((l) => /has not asked/.test(l)));
    await sleep(200);
    assert.strictEqual(Object.keys(st.mock.state.sessions).length, 0, 'the transcode was left running');
    await st.close();
});

test('service: a long film is read ahead of the player without running away (24 MiB or 90 s at most)', async () => {
    const { st, cmd } = await linked({ filmSeconds: 3000, speed: 1 });
    await cmd({ cmd: 'play', key: '102', offset: 0 });
    await playing(st);
    await st.settle(1500);
    const s = st.mock.state.sessions[Object.keys(st.mock.state.sessions)[0]];
    // the player holds 6 s and the reader 90 s more, 2 s a segment; the pipes between them hold a few more of
    // this film's tiny segments (40 kB each): some 50 to 70 segments, not all 1500
    assert.ok(s.segments.length >= 40 && s.segments.length <= 75, s.segments.length + ' segments were read');
    assert.ok(st.S.pb().ahead >= 80 && st.S.pb().ahead <= 92, 'ahead ' + st.S.pb().ahead);
    assert.strictEqual(st.S.pb().state, 'playing');
    await cmd({ cmd: 'stop' });
    await st.close();
});

/* ---------------- the app: its store and pages ---------------- */

test('app: from the sign-in to a film and back, by taps', async () => {
    const st = await createStage({ linked: false, filmSeconds: 200 });
    const S = st.S;
    await st.settle(200);
    assert.strictEqual(S.page, 'link');
    assert.deepStrictEqual(st.frame().targets.map((t) => t.key), ['ln_get']);
    st.tap('ln_get');
    await st.until(() => S.st.link && S.st.link.code, 5000, 'the code');
    assert.ok(st.frame().targets.some((t) => t.key === 'ln_cancel'));
    st.mock.link();
    await st.until(() => S.page === 'home' && S.home.at, 10000, 'home');
    let keys = st.frame().targets.map((t) => t.key);
    ['rail_home', 'rail_lib1', 'rail_lib2', 'rail_search', 'rail_server'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ' on the home page: ' + keys.join(' ')));
    assert.ok(keys.some((k) => /^deck_/.test(k)) && keys.some((k) => /^rec_/.test(k)));
    st.tap('rail_lib1');
    await st.until(() => S.lib && S.lib.items.length === 14, 5000, 'the films');
    // only what is on screen is drawn and can be tapped; the list scrolls
    keys = st.frame().targets.map((t) => t.key).filter((k) => /^li_/.test(k));
    assert.ok(keys.length >= 8 && keys.length <= 16, keys.length + ' posters can be tapped');
    assert.strictEqual(st.frame().cv.scroll, true);
    assert.strictEqual(st.ui.scroll(-50), false, 'scrolled above its top');
    assert.strictEqual(st.ui.scroll(50), true);
    assert.strictEqual(S.lib.scroll, 50);
    assert.strictEqual(st.ui.scroll(100000), true);
    assert.strictEqual(st.ui.scroll(10), false, 'scrolled below its end');
    st.tap('lib_sort'); st.frame();
    // a list to pick from is the only thing that takes taps
    keys = st.frame().targets.map((t) => t.key);
    assert.ok(keys.every((k) => /^pk_/.test(k)), keys.join(' '));
    st.tap('pk_2');
    await st.until(() => S.lib.sort === 'year' && S.lib.items.length === 14 && !S.picker, 5000, 'the new order');
    assert.strictEqual(S.lib.items[0].year, 2024);
    S.open(S.lib.items.filter((x) => x.title === 'Night Freight')[0]);
    await st.until(() => S.page === 'detail' && S.detail.item, 5000, 'the film\'s page');
    keys = st.frame().targets.map((t) => t.key);
    ['back', 'd_resume', 'd_start', 'd_seen', 'd_audio', 'd_subs'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ': ' + keys.join(' ')));
    st.tap('d_subs'); st.frame(); st.tap('pk_1');
    await st.until(() => S.detail.subtitle !== null, 3000, 'the subtitles');
    st.tap('d_resume');
    assert.strictEqual(S.page, 'player');
    await st.until(() => S.pb() && S.pb().state === 'playing', 10000, 'playing');
    assert.strictEqual(S.pb().subtitles, true);
    assert.strictEqual(st.mock.state.sessions[Object.keys(st.mock.state.sessions)[0]].args.subtitles, 'burn');
    S.overlayUntil = Date.now() + 5000;
    keys = st.frame().targets.map((t) => t.key);
    ['back', 'p_back10', 'p_play', 'p_fwd30', 'p_stop', 'p_pic'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ': ' + keys.join(' ')));
    assert.strictEqual(keys[keys.length - 1], 'p_pic', 'the picture\'s own target must come last: a tap goes to the first under the finger');
    assert.ok(st.ui.scrub && st.ui.scrub.dur === 200);
    st.tap('p_play');
    await st.until(() => S.pb().state === 'paused', 3000, 'paused');
    st.tap('p_stop');
    await st.until(() => !S.pb() || S.pb().state === 'idle', 3000, 'stopped');
    assert.strictEqual(S.page, 'detail');
    assert.strictEqual(S.back(), true); assert.strictEqual(S.page, 'library');
    assert.strictEqual(S.back(), true); assert.strictEqual(S.page, 'home');
    assert.strictEqual(S.back(), false, 'nothing before home: the HMI closes the screen');
    await st.close();
});

test('app: driving, the picture is off unless the setting is on and its disclaimer was accepted while parked', async () => {
    const { st } = await linked({ filmSeconds: 4000, speed: 1 });
    const S = st.S;
    // how many times the player page asks for the film's picture when it is drawn now
    const video = () => {
        let n = 0;
        const real = require(path.join(ROOT, 'kit', 'runtime', 'record')).Recorder.prototype.video;
        const cv = new (require(path.join(ROOT, 'kit', 'runtime', 'record')).Recorder)(1600, 520, { textScale: 1.165 });
        cv.place = st.PLACE; cv.own = true; cv.extra = st.PLACE.extra;
        cv.video = function () { n++; return real.apply(this, arguments); };
        st.ui.drawPlayer(cv, { x: 33, y: 38, w: 1547, h: 523, bottom: 561, right: 1580 }, 569);
        return n;
    };
    S.play({ key: '102' }, 0);
    await st.until(() => S.pb() && S.pb().state === 'playing', 10000, 'playing');
    st.car.parked = true;
    assert.strictEqual(video(), 1, 'parked: the picture');
    st.car.parked = false;
    assert.strictEqual(video(), 0, 'driving: no picture');
    st.frame();
    assert.ok(st.frame().targets.some((t) => t.key === 'p_play'), 'driving: the controls stay');
    st.values.motion = true;
    assert.strictEqual(video(), 0, 'driving, the setting on, no disclaimer accepted: no picture');
    // the disclaimer: not accepted on the move
    S.page = 'consent';
    assert.strictEqual(st.frame().targets.filter((t) => t.key === 'c_yes').length, 0, 'driving: "I understand" cannot be tapped');
    assert.ok(st.frame().targets.some((t) => t.key === 'c_no'));
    st.car.parked = true;
    st.frame(); st.tap('c_yes');
    assert.strictEqual(st.car.consent.given(), true);
    st.car.parked = false;
    S.page = 'player';
    assert.strictEqual(video(), 1, 'driving, the setting on and the disclaimer accepted: the picture');
    // "leave it off" switches the setting off again and forgets the consent
    S.page = 'consent'; st.frame(); st.tap('c_no');
    assert.deepStrictEqual([st.values.motion, st.car.consent.given()], [false, false]);
    S.page = 'player';
    assert.strictEqual(video(), 0);
    S.stop();
    await st.close();
});

test('app: the next episode starts by itself after a count, or not when the owner cancels', async () => {
    const { st } = await linked({ filmSeconds: 12 });
    const S = st.S;
    const shows = await st.svc.command({ cmd: 'section', key: '2', type: 'show' });
    const seasons = (await st.svc.command({ cmd: 'children', key: shows.items[0].key })).items;
    const eps = (await st.svc.command({ cmd: 'children', key: seasons[0].key })).items;
    S.play(eps[0], 0);
    await st.until(() => S.pb() && S.pb().state === 'ended', 10000, 'the end');
    assert.ok(S.nextAt > Date.now(), 'no count for the next episode');
    assert.ok(st.frame().targets.some((t) => t.key === 'p_nextnow') && st.frame().targets.some((t) => t.key === 'p_nextno'));
    st.tap('p_nextnow');
    await st.until(() => S.pb().item && S.pb().item.key === eps[1].key && S.pb().state === 'playing', 10000, 'the next episode');
    await st.until(() => S.pb().state === 'ended' && S.pb().item.key === eps[1].key, 10000, 'its end');
    st.frame(); st.tap('p_nextno');
    assert.strictEqual(S.nextAt, 0);
    await st.settle(400);
    assert.strictEqual(S.pb().item.key, eps[1].key, 'it started although cancelled');
    // with the setting off there is no count
    st.values.autoplay = false;
    S.play(eps[2], 0);
    await st.until(() => S.pb().state === 'ended' && S.pb().item.key === eps[2].key, 10000, 'the third\'s end');
    assert.strictEqual(S.nextAt, 0);
    await st.close();
});

test('app: every page draws, with the service missing, offline, loading and failing too', async () => {
    const st = await createStage({ linked: false, filmSeconds: 40 });
    const S = st.S;
    // no service at all
    S.st = null; S.svcErr = 'the Drive-In service is not installed'; S.svcErrCode = 'ENOSVC';
    assert.ok(st.frame().cv.words().length > 20);
    S.svcErr = null; S.svcErrCode = null;
    await st.settle(200);
    ['link', 'home', 'library', 'show', 'detail', 'search', 'player', 'consent'].forEach((p) => { S.page = p; st.frame(); });
    st.mock.link(); S.linkStart();
    await st.until(() => S.connected() && S.home.at, 10000, 'home');
    S.openLibrary(S.home.sections[1]);
    await st.until(() => S.lib.items.length, 5000, 'the shows');
    S.open(S.lib.items[2]);
    await st.until(() => S.show && S.show.seasons.length, 5000, 'the seasons');
    assert.ok(st.frame().targets.some((t) => t.key === 'sh_season'));
    st.tap('sh_season'); st.frame(); st.tap('pk_1');
    await st.until(() => S.show.sel === 1 && S.show.episodes[S.show.seasons[1].key].items, 5000, 'the second season');
    S.top('search'); st.frame();
    'kiln'.split('').forEach((c) => st.tap('k_' + [0, 1, 2].filter((r) => S.search.kb.rows()[r].indexOf(c) >= 0)[0] + '_' + c));
    assert.strictEqual(S.search.field.value, 'kiln');
    st.tap('k_3_#enter');
    await st.until(() => S.search.results && S.search.results.length === 1, 5000, 'the search');
    st.frame(); st.tap('sr_' + S.search.results[0].key);
    await st.until(() => S.page === 'show' && S.show.seasons.length, 5000, 'the show found');
    // a title in letters the font does not have, a very long one, no summary: still drawn
    S.detail = { key: '1', loading: false, error: null, subtitle: null, item: { key: '1', type: 'movie', title: '日本語 ' + 'W'.repeat(300), duration: 0, viewOffset: 0, viewCount: 0, media: [], genres: [] } };
    S.page = 'detail'; st.frame();
    S.page = 'home';
    S.picker = { title: 'x'.repeat(200), rows: Array.from({ length: 40 }, (_, i) => ({ label: 'row ' + i, on: i === 3, run() {} })) };
    assert.ok(st.frame().targets.length <= 12, 'a long list to pick from runs off the screen');
    S.picker = null;
    await st.close();
});

/* ---------------- main.js on a stand-in head unit ---------------- */

test('main.js: starts on a stand-in head unit from the staged package; the wheel, the speakers, the disclaimer', async () => {
    const py = ['python3', 'python'].filter((p) => { try { return spawnSync(p, ['--version']).status === 0; } catch (e) { return false; } })[0];
    if (!py) { print('     (skipped: no Python 3 for the kit\'s build)'); return; }
    // the kit's build needs an SDK folder: a clearly marked stand-in, never loaded here and refused by a car build
    const sdk = path.join(ROOT, 'oap-sdk');
    if (!fs.existsSync(path.join(sdk, 'index.js'))) {
        fs.mkdirSync(sdk);
        fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'oap-sdk', version: '0.0.0-pc-placeholder', description: 'NOT BMW\'s SDK: an empty stand-in so the kit\'s build can stage the app on a PC.' }, null, 2) + '\n');
        fs.writeFileSync(path.join(sdk, 'index.js'), '\'use strict\';\n// NOT BMW\'s SDK: an empty stand-in so the kit\'s build can stage the app on a PC (which never loads it).\nthrow new Error(\'oap-sdk PC placeholder\');\n');
    }
    const b = spawnSync(py, [path.join(ROOT, 'kit', 'tools', 'build.py'), 'clucraft_plex'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(b.status, 0, 'the kit\'s build failed:\n' + b.stdout + b.stderr);
    const JS = path.join(ROOT, 'dist', 'clucraft_plex', 'source', 'javascript');
    ['app.js', 'store.js', 'ui.js', 'svc.js', 'drivegate.js', 'caraudio.js', 'fullview.js', 'keyboard.js', 'qrcodegen.js', 'fonts.pack', path.join('kit', 'fullscreen.js')]
        .forEach((f) => assert.ok(fs.existsSync(path.join(JS, f)), 'the package has no ' + f));

    // the service on a local port, for the package's own svc.js
    const { st } = await linked({ filmSeconds: 4000, speed: 1 });
    const server = net.createServer();
    st.svc.serve(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.PLEXD_SOCK = String(server.address().port);

    // the head unit: what main.js asks of the kit
    const EventEmitter = require('events');
    const logged = { error: [], warn: [], info: [] };
    const log = { info: (s) => logged.info.push(String(s)), warn: (s) => logged.warn.push(String(s)), error: (s) => logged.error.push(String(s)), debug() {} };
    const values = { motion: false, quality: '720', autoplay: true, wheel: true, gain: '6', signout: 'no' }, listeners = [];
    const settings = { get: (k) => values[k], set(k, v) { values[k] = v; listeners.forEach((fn) => fn(k, v)); }, onChange(fn) { listeners.push(fn); } };
    // the car's audio manager: it keeps the connections it was asked for
    const watched = {}, calls = [];
    let mains = [], mainId = 41;
    const signals = {
        watch(iface, inst, handlers) { watched[iface] = handlers; return Promise.resolve({ available: true }); },
        proxy(iface) { return Promise.resolve({ iface }); },
        call(p, method, params) {
            calls.push({ iface: p.iface, method, params });
            if (method === 'getListMainConnections') return Promise.resolve(mains.slice());
            if (method === 'connect') { mains.push({ mainConnectionID: ++mainId, sourceID: params.sourceID, sinkID: params.sinkID }); return Promise.resolve({ amError: 'E_OK', mainConnectionID: mainId }); }
            if (method === 'disconnect') mains = mains.filter((c) => c.mainConnectionID !== params.mainConnectionID);
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
    const record = require(path.join(JS, 'kit', 'record'));
    class Gpu extends EventEmitter {
        constructor() { super(); this.ready = true; this.native = true; this.touch = true; this.info = { video: true, touch: true, controller: true }; this.visible = true; this.videos = []; this.frames = 0; this.waiting = false; }
        connect() { setImmediate(() => this.emit('ready')); return this; }
        place() {} claim() {} grab() {} close() {}
        show(v) { this.visible = !!v; }
        video(id, file) { this.videos.push([id, file]); return true; }
        frame() { this.frames++; }
    }
    const gpu = new Gpu(), fullGpus = [];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-'));
    let loopFn = null, backFn = null, scrollFn = null, touchFn = null, lastCv = null, sheetClosed = 0;
    const clicks = {};
    const ctx = {
        log, settings, signals, dataDir,
        ui: { onClick(n, fn) { clicks[n] = fn; }, isVisible: (n) => n === 'MAIN', hasFocus: () => true, onVisible() {}, image(n, cv) { lastCv = cv; return Promise.resolve(); } },
        display: { gpu, place: st.PLACE, closeSheet() { sheetClosed++; }, _syncVisible() { gpu.visible = true; } },
        canvas(w, h) { const cv = new record.Recorder(w, h, { textScale: st.PLACE.scale }); cv.place = st.PLACE; cv.own = true; cv.extra = st.PLACE.extra; cv.chrome = null; return cv; },
        loop(name, fps, fn) { loopFn = fn; return { stop() {} }; },
        theme: () => ({}), hideButton() {},
        onTouch(fn) { touchFn = fn; }, onBack(fn) { backFn = fn; }, onScroll(fn) { scrollFn = fn; },
    };
    let impl = null;
    const realLoad = Module._load;
    Module._load = function (req, parent) {
        if (parent && parent.filename && parent.filename.indexOf(JS) === 0 && parent.filename.indexOf(path.join(JS, 'kit')) !== 0) {
            if (req === './kit/mgu') return { run(i) { impl = i; } };
            if (req === './kit/renderd') return { RenderClient: class extends Gpu { constructor() { super(); fullGpus.push(this); } } };
        }
        return realLoad.apply(this, arguments);
    };
    // the player's frame file "exists" once a film plays: main.js looks for it at its fixed place
    const realStat = fs.statSync;
    let videoFile = false;
    fs.statSync = function (p) { if (p === '/dev/shm/mgu-video-clucraft-plex') { if (!videoFile) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { ino: 77 }; } return realStat.apply(fs, arguments); };
    try {
        require(path.join(JS, 'app.js'));
        assert.ok(impl && typeof impl.start === 'function', 'main.js did not hand the kit its start');
        await impl.start(ctx);
        assert.ok(loopFn && backFn && scrollFn && touchFn, 'main.js did not take the loop, back, scroll and touch');
        ['BTN_HOME', 'BTN_NOW', 'BTN_PLAYPAUSE', 'BTN_STOP'].forEach((n) => assert.ok(clicks[n], 'no handler for ' + n));
        assert.ok(watched['de.bmw.infotainment.vehicle.Vehicle2'] && watched['de.bmw.infrastructure.VehicleInformation'], 'the drive gate does not watch the car');
        const speed = (kmh) => watched['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh * 64) });
        const gear = (g) => watched['de.bmw.infrastructure.VehicleInformation'].statusGearboxDrive({ statusActualStageDrive: g });
        const frames = async (ms) => { const t = Date.now() + ms; while (Date.now() < t) { await loopFn(); await sleep(60); } };
        const tap = (key) => { const t = lastCv.targets.filter((x) => x.key === key)[0]; assert.ok(t, 'no target ' + key + ' (' + lastCv.targets.map((x) => x.key).join(' ') + ')'); t.run(); };
        speed(0); gear('P');
        await frames(2500);                                           // the status, home, its posters
        assert.ok(lastCv.targets.some((t) => t.key === 'rail_lib1'), 'not on the home page: ' + lastCv.targets.map((t) => t.key).join(' '));
        assert.ok(lastCv.targets.some((t) => /^deck_/.test(t.key)), 'no "continue watching"');
        assert.strictEqual(scrollFn(100), false, 'the home page does not scroll');

        // a film from "continue watching": the player goes over the whole screen, the speakers are asked for
        tap(lastCv.targets.filter((t) => /^deck_/.test(t.key))[0].key);
        videoFile = true;
        await frames(2500);
        assert.strictEqual(fullGpus.length, 1, 'no second connection for the full view');
        assert.ok(fullGpus[0].frames > 3, 'the full view drew nothing');
        assert.strictEqual(gpu.visible, false, 'the page is not hidden under the full view');
        assert.ok(gpu.videos.length === 1 && fullGpus[0].videos.length === 1 && gpu.videos[0][1] === '/dev/shm/mgu-video-clucraft-plex', 'the video file was not named to the renderer');
        const con = calls.filter((c) => c.method === 'connect')[0];
        assert.ok(con && con.params.sourceID === 287 && con.params.sinkID === 1024, 'the sound was not routed to the speakers: ' + JSON.stringify(calls.map((c) => c.method)));
        let s = await st.svc.command({ cmd: 'status' });
        assert.strictEqual(s.playback.state, 'playing');
        const at = s.playback.pos;

        // the steering wheel's skip, on release: 30 s on
        const wheel = watched['de.bmw.infotainment.controlelements.SteeringWheelPushButton'].statusSearchSwitch1;
        wheel({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'X_SKIP_RECHTS' });
        wheel({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'KEINE_AKTION' });
        await frames(2500);
        s = await st.svc.command({ cmd: 'status' });
        assert.ok(s.playback.pos > at + 25, 'the wheel did not skip: ' + at + ' -> ' + s.playback.pos);

        // the controller on the full view: press pauses
        fullGpus[0].emit('ccu', { frontRotaryEncoderOperation: 10, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
        fullGpus[0].emit('ccu', { frontRotaryEncoderOperation: 10, frontRotaryEncoderPushButton: 1, frontRotaryEncoderDeflection: 0 });
        await frames(1200);
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).playback.state, 'paused');
        assert.ok(calls.some((c) => c.method === 'disconnect') && mains.length === 0, 'paused: the speakers were not given back');
        clicks.BTN_PLAYPAUSE();
        await frames(1500);
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).playback.state, 'playing');
        assert.strictEqual(mains.length, 1, 'playing again: the speakers were not asked for again');

        // "Video while driving" switched on in the settings: the disclaimer, not the picture
        backFn();                                                     // (the HMI's back: out of the player)
        await frames(300);
        speed(60); gear('D');
        settings.set('motion', true);
        await frames(300);
        assert.ok(sheetClosed >= 1, 'the settings sheet was not closed for the disclaimer');
        assert.ok(lastCv.targets.some((t) => t.key === 'c_no') && !lastCv.targets.some((t) => t.key === 'c_yes'), 'driving: the disclaimer can be accepted');
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'passenger.json')), false);
        speed(0); gear('P');
        await frames(200);
        tap('c_yes');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'passenger.json'), 'utf8')).accepted, true);
        assert.strictEqual(values.motion, true);
        settings.set('motion', false);                                // off again: the consent goes with it
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'passenger.json')), false);
        settings.set('motion', true);
        await frames(200);
        tap('c_no');
        assert.strictEqual(values.motion, false);

        clicks.BTN_STOP();
        await frames(800);
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).playback.state, 'idle');
        assert.deepStrictEqual(logged.error, [], 'main.js logged errors');
        assert.ok(logged.info.some((l) => /^started 0\.1\.0/.test(l)), logged.info.join('\n'));
    } finally {
        Module._load = realLoad; fs.statSync = realStat; delete process.env.PLEXD_SOCK;
        server.close();
        await st.close();
    }
});

/* ---------------- the repository ---------------- */

test('emulator: what tools/emu.js changes in the kit is there to change, once', () => {
    const E = require(path.join(ROOT, 'tools', 'emu'));
    assert.ok(/^[0-9a-f]{40}$/.test(E.EMU_COMMIT), 'the emulator is pinned to a commit');
    // this repository's own file among them
    const mine = E.ADAPT.filter((a) => a[0] === 'kit/runtime/renderd.js');
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(ROOT, mine[0][0]), 'utf8').split(mine[0][2]).length, 2, 'renderd.js has the line once');
    // the kit's emulator files, when a checkout is at hand (npm run emu fetched one, or IDRIVE7_APPS names one)
    const kit = [process.env.IDRIVE7_APPS, path.join(ROOT, 'vendor', 'idrive7-apps')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'kit', 'tools', 'emu.js')));
    for (const [file, what, from, to] of E.ADAPT) {
        assert.ok(from !== to && to.length > from.length - 40 && what, file);
        if (!kit || file === 'kit/runtime/renderd.js') continue;
        assert.strictEqual(fs.readFileSync(path.join(kit, file), 'utf8').replace(/\r\n/g, '\n').split(from).length, 2, file + ': ' + what);
    }
    // the app and its backend find each other by a port, and the stand-in SDK says what it is
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'emu.js'), 'utf8');
    assert.ok(/PLEXD_SOCK: backendPort/.test(src) && /NOT BMW's SDK/.test(src));
});

test('repository: the versions and manifests agree; nothing of BMW\'s and no account is in it', () => {
    const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const app = j('apps/clucraft_plex/app.json'), comp = j('native/clucraft-plex/component.json'), repo = j('mgu-repo.json'), pkg = j('package.json');
    const ver = (f, re) => (re.exec(fs.readFileSync(path.join(ROOT, f), 'utf8')) || [])[1];
    assert.strictEqual(ver('apps/clucraft_plex/main.js', /const VERSION = '([\d.]+)'/), app.version, 'main.js and app.json');
    assert.strictEqual(ver('native/clucraft-plex/service.js', /const VERSION = '([\d.]+)'/), comp.version, 'service.js and component.json');
    assert.strictEqual(app.requires['clucraft-plex'], comp.version, 'the app asks for another service version');
    assert.strictEqual(pkg.version, app.version);
    assert.strictEqual(repo.apps.manifest, 'app.json');
    assert.deepStrictEqual(repo.components.map((c) => c.id + ':' + c.path), ['clucraft-plex:native/clucraft-plex']);
    comp.files.concat(comp.units).forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, 'native/clucraft-plex', f.from)), 'component.json names ' + f.from + ', which is not there'));
    // every script of the tool is in its manifest (a file left out would be missing on the car)
    fs.readdirSync(path.join(ROOT, 'native/clucraft-plex')).filter((f) => /\.js$/.test(f)).forEach((f) => assert.ok(comp.files.some((x) => x.from === f), f + ' is not in component.json'));
    assert.deepStrictEqual(comp.uids, [ver('native/clucraft-plex/service.js', /const NET_UID = (\d+)/)].map(Number));
    assert.ok(app.settings.filter((s) => s.key === 'motion')[0].default === false, 'video while driving must be off by default');
    // what must never be committed
    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    ['/oap-sdk/', 'dist/'].forEach((p) => assert.ok(ignored.indexOf(p) >= 0, '.gitignore does not name ' + p));
    const sources = [];
    const walk = (d) => fs.readdirSync(d).forEach((f) => { const p = path.join(d, f); if (/^(\.git|node_modules|dist|oap-sdk|\.cache)$/.test(f)) return; if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|json|md|service|socket)$/.test(f)) sources.push(p); });
    walk(ROOT);
    sources.filter((p) => p !== __filename).forEach((p) => {
        const t = fs.readFileSync(p, 'utf8');
        assert.ok(!/X-Plex-Token=[A-Za-z0-9_-]{10,}/.test(t), path.relative(ROOT, p) + ' holds a token');
        assert.ok(!/isParked\(\)\s*\{[^}]*return true;/.test(t) && !/FORCES "PARKED"/.test(t), path.relative(ROOT, p) + ' forces "parked"');
    });
});

/* ---------------- run ---------------- */
(async () => {
    const only = process.argv[2];
    let failed = 0, ran = 0;
    for (const t of tests) {
        if (only && t.name.indexOf(only) < 0) continue;
        ran++;
        const t0 = Date.now();
        try { await t.fn(); print('ok   ' + t.name + '  (' + (Date.now() - t0) + ' ms)'); }
        catch (e) { failed++; print('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    print('\n' + (ran - failed) + ' of ' + ran + ' passed on Node ' + process.version);
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
