import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { features, providerOf, keysOf, cached, Features, handleFeatures, GOALS, REGISTRY, FEATURE_WORDS_FR, featureWords } from '../server/features.mjs';
import { JsonFile } from '../server/store.mjs';

const OVH = { name: 'OVH_AI_ENDPOINTS_KEY', expired: false };
const ids = (r) => r.capabilities.map((c) => c.id);
const cap = (r, id) => r.capabilities.find((c) => c.id === id);
const ctxWith = (more = {}) => ({ tools: ['shell', 'opencode'], ...more });

test('a secret is known by its name: the short table first, then the names the catalogue says each provider reads', () => {
    assert.equal(providerOf('OVH_AI_ENDPOINTS_KEY'), 'ovh');
    assert.equal(providerOf('OVHCLOUD_API_KEY'), 'ovh');
    assert.equal(providerOf('MISTRAL_API_KEY'), 'mistral');
    assert.equal(providerOf('ELEVENLABS_API_KEY'), 'elevenlabs');
    assert.equal(providerOf('SOME_TOKEN'), null);
    assert.equal(providerOf('DEEPTHING_KEY', [{ id: 'deepthing', env: ['DEEPTHING_KEY'] }]), 'deepthing');
    /* Expired or ephemeral: no suggestion is born of it. */
    assert.deepEqual(keysOf([{ name: 'MISTRAL_API_KEY', expired: true }, { name: 'GROQ_API_KEY', ephemeral: true }, OVH]), [{ name: 'OVH_AI_ENDPOINTS_KEY', provider: 'ovh' }]);
});

test('an OVH key gives a dictation ready in two clicks, its model already chosen -- and it is the next step', () => {
    const r = features(ctxWith({ secrets: [OVH] }));
    const d = cap(r, 'dictation');
    assert.equal(d.status, 'off');
    assert.equal(d.suggestion.action, 'dictation');
    assert.equal(d.suggestion.provider, 'ovh');
    assert.equal(d.suggestion.model, 'whisper-large-v3-turbo');
    assert.deepEqual(d.suggestion.models.map((m) => m.id), ['whisper-large-v3-turbo', 'whisper-large-v3']);
    assert.equal(d.suggestion.secret, 'OVH_AI_ENDPOINTS_KEY');
    assert.equal(d.suggestion.effort, '2 clicks');
    assert.equal(r.next, 'dictation');
    /* Never a value: only the name of the secret travels. */
    assert.doesNotMatch(JSON.stringify(r), /value/);
});

test('without any key, dictation asks for an account elsewhere, and the backup comes first', () => {
    const r = features(ctxWith());
    assert.equal(cap(r, 'dictation').suggestion.effort, 'account elsewhere');
    assert.equal(r.next, 'backup');
});

test('order is impact: the doc\'s example -- dictation 5, backup 4, then alerts, OpenCode, mail, boxes, voice', () => {
    const r = features(ctxWith({ secrets: [OVH] }));
    const withSuggestion = r.capabilities.filter((c) => c.suggestion).map((c) => c.id);
    assert.deepEqual(withSuggestion.slice(0, 3), ['dictation', 'backup', 'alerts']);
    assert.ok(withSuggestion.indexOf('opencode') < withSuggestion.indexOf('mail'));
    assert.ok(withSuggestion.indexOf('mail') < withSuggestion.indexOf('boxes'));
    assert.equal(withSuggestion.at(-1), 'speech');
    /* Boxes require dictation: blocked, said so, never the next step. */
    assert.deepEqual(cap(r, 'boxes').blockedBy, ['dictation']);
    assert.deepEqual(cap(r, 'dictation').unlocks, ['boxes']);
});

test('goals weigh twice, they hide nothing: "peace of mind" puts the backup before dictation', () => {
    const r = features(ctxWith({ secrets: [OVH] }), { goals: ['calm'] });
    assert.equal(r.next, 'backup');
    assert.equal(r.capabilities.length, REGISTRY.length);
    assert.deepEqual(r.goals, ['calm']);
});

test('statuses are read from what the modules say', () => {
    const r = features(ctxWith({
        secrets: [OVH, { name: 'ELEVENLABS_API_KEY' }],
        dictation: { on: true, provider: 'ovh' },
        boxes: [{ online: true }, { online: false }], alerts: 2,
        conversations: [{ tool: 'opencode' }, { tool: 'shell' }],
        mail: { mailboxes: [], targets: [{ kind: 'calendar' }] }, answerer: 1,
        screen: { installed: true, running: true }, updates: { installed: true, mode: 'ask', channel: 'latest', window: '02:00-05:00' }, team: 1,
        backupAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    }));
    const s = Object.fromEntries(r.capabilities.map((c) => [c.id, [c.status, c.word]]));
    assert.deepEqual(s.dictation, ['ready', 'OVH AI Endpoints']);
    assert.deepEqual(s.boxes, ['partial', '1 of 2 online']);
    assert.deepEqual(s.speech, ['ready', 'ElevenLabs']);
    assert.deepEqual(s.alerts, ['ready', '2 devices']);
    assert.deepEqual(s.opencode, ['ready', '1 conversation']);
    assert.deepEqual(s.answerer, ['partial', '1 model']);
    assert.deepEqual(s.mail, ['ready', '1 account']);
    assert.deepEqual(s.screen, ['ready', 'On']);
    assert.deepEqual(s.backup, ['ready', '2 days ago']);
    assert.deepEqual(s.signin, ['ready', 'Just you']);
    assert.deepEqual(s.updates, ['partial', 'When asked']);
    assert.equal(cap(r, 'updates').suggestion.action, 'updates');
});

test('a feature that stopped working is a problem with its repair, first, and never a suggestion', () => {
    const r = features(ctxWith({ secrets: [OVH], dictation: { on: true, provider: 'ovh', secretExpired: true }, screen: { installed: true, running: false } }));
    assert.deepEqual(ids(r).slice(0, 2).sort(), ['dictation', 'screen']);
    assert.equal(cap(r, 'dictation').status, 'problem');
    assert.equal(cap(r, 'dictation').suggestion, undefined);
    assert.equal(cap(r, 'screen').repair.action, 'screen');
    assert.equal(r.counts.problems, 2);
    assert.notEqual(r.next, 'dictation');
    /* Never set is never a problem. */
    assert.equal(cap(features(ctxWith()), 'screen').status, 'off');
});

test('a backup older than a month is said as old, and suggested again', () => {
    const r = features(ctxWith({ backupAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
    assert.equal(cap(r, 'backup').status, 'partial');
    assert.equal(cap(r, 'backup').word, '40 days ago');
    assert.ok(cap(r, 'backup').suggestion);
});

test('the welcome: only with no conversation, and never once passed', () => {
    assert.equal(features(ctxWith()).welcome, true);
    assert.equal(features(ctxWith(), { welcomeDone: true }).welcome, false);
    assert.equal(features(ctxWith({ conversations: [{ tool: 'shell' }] })).welcome, false);
});

test('sharing is on unless the owner turned it off, and nothing is ever sent', () => {
    assert.deepEqual(features(ctxWith()).sharing, { on: true, sends: false });
    assert.deepEqual(features(ctxWith(), { sharing: false }).sharing, { on: false, sends: false });
});

function bench(t, ctx = ctxWith({ secrets: [OVH] })) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-features-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = { ctx };
    const file = join(dir, 'features.json');
    const make = () => new Features({ file: new JsonFile(file, {}), context: async () => state.ctx });
    return { state, file, make, f: make() };
}

test('"Not for me": hidden until its cause changes -- another key brings it back, the same never does', async (t) => {
    const b = bench(t);
    let r = await b.f.dismiss({ id: 'dictation' });
    assert.equal(cap(r, 'dictation').suggestion, undefined);
    assert.equal(cap(r, 'dictation').dismissed, true);
    assert.equal(r.counts.hidden, 1);
    assert.notEqual(r.next, 'dictation');
    /* Kept on disk: a restart does not bring it back. */
    r = await b.make().about();
    assert.equal(cap(r, 'dictation').suggestion, undefined);
    /* Another provider's key: another cause, so a suggestion again. */
    b.state.ctx = ctxWith({ secrets: [{ name: 'MISTRAL_API_KEY' }] });
    r = await b.f.about();
    assert.equal(cap(r, 'dictation').suggestion.provider, 'mistral');
    /* And all of them back, on demand. */
    b.state.ctx = ctxWith({ secrets: [OVH] });
    r = await b.f.dismiss({ restore: true });
    assert.equal(cap(r, 'dictation').suggestion.provider, 'ovh');
    await assert.rejects(b.f.dismiss({ id: 'nothing' }), /No such feature/);
});

test('the home banner: hidden with its x, back only when a suggestion never seen is born', async (t) => {
    const b = bench(t);
    assert.equal((await b.f.about()).home.show, true);
    assert.equal((await b.f.dismiss({ id: 'home' })).home.show, false);
    assert.equal((await b.make().about()).home.show, false);
    b.state.ctx = ctxWith({ secrets: [OVH, { name: 'ELEVENLABS_API_KEY' }] });
    assert.equal((await b.f.about()).home.show, false, 'a suggestion gone is nothing new');
    b.state.ctx = ctxWith({ secrets: [{ name: 'MISTRAL_API_KEY' }] });
    assert.equal((await b.f.about()).home.show, true, 'dictation with Mistral was never seen');
});

test('goals are kept and checked; sharing and the welcome are kept; an export is the backup\'s day', async (t) => {
    const b = bench(t);
    assert.deepEqual((await b.f.setGoals(['calm', 'code', 'calm'])).goals, ['calm', 'code']);
    await assert.rejects(b.f.setGoals(['fly']), /Goals are among/);
    await assert.rejects(b.f.setGoals('calm'), /Goals are among/);
    assert.deepEqual(b.f.setSharing(false), { on: false, sends: false });
    assert.throws(() => b.f.setSharing('yes'), /true or false/);
    assert.equal((await b.f.welcomeDone()).welcome, false);
    b.f.exported();
    const r = await b.make().about();
    assert.deepEqual(r.goals, ['calm', 'code']);
    assert.equal(r.sharing.on, false);
    assert.equal(cap(r, 'backup').status, 'ready');
    const kept = JSON.parse(readFileSync(b.file, 'utf8'));
    assert.deepEqual(Object.keys(kept).sort(), ['backupAt', 'goals', 'sharing', 'welcomeDone']);
    assert.deepEqual(GOALS, ['home', 'dictate', 'mail', 'code', 'work', 'calm']);
});

/* A request as the server receives it. */
function call(f, method, path, body, { origin = true, type = 'application/json' } = {}) {
    const request = new PassThrough(); Object.assign(request, { method, url: path, headers: { 'content-type': type } });
    const out = { status: 0, body: null };
    const response = { writeHead(status) { out.status = status; return this; }, end(text) { out.body = JSON.parse(text); } };
    const done = handleFeatures(request, response, f, () => origin);
    request.end(body === undefined ? '' : JSON.stringify(body));
    return done.then((handled) => ({ handled, ...out }));
}

test('the routes: read; dismiss, goals, sharing, welcome; refused from another site; others left to the rest', async (t) => {
    const b = bench(t);
    let r = await call(b.f, 'GET', '/api/features');
    assert.equal(r.status, 200); assert.equal(r.body.next, 'dictation');
    r = await call(b.f, 'POST', '/api/features/goals', { goals: ['calm'] });
    assert.equal(r.status, 200); assert.equal(r.body.next, 'backup');
    r = await call(b.f, 'POST', '/api/features/goals', { goals: ['nope'] });
    assert.equal(r.status, 400);
    r = await call(b.f, 'POST', '/api/features/dismiss', { id: 'backup' });
    assert.equal(cap(r.body, 'backup').dismissed, true);
    r = await call(b.f, 'POST', '/api/features/sharing', { on: false });
    assert.deepEqual(r.body, { on: false, sends: false });
    r = await call(b.f, 'POST', '/api/features/welcome', {});
    assert.equal(r.body.welcome, false);
    r = await call(b.f, 'POST', '/api/features/goals', { goals: [] }, { origin: false });
    assert.equal(r.status, 403);
    r = await call(b.f, 'POST', '/api/features/goals', { goals: [] }, { type: 'text/plain' });
    assert.equal(r.status, 403);
    r = await call(b.f, 'POST', '/api/features/other', {});
    assert.equal(r.handled, false);
});

test('a slow look is kept a while, and asked once at a time', async () => {
    let now = 0; let asked = 0;
    const read = cached(async () => { asked += 1; return asked; }, 1000, () => now);
    assert.deepEqual(await Promise.all([read(), read()]), [1, 1]);
    now = 500; assert.equal(await read(), 1);
    now = 1600; assert.equal(await read(), 2);
    assert.equal(asked, 2);
});

test('every word of the page and of the registry has its French', () => {
    const page = readFileSync(new URL('../web/features.js', import.meta.url), 'utf8');
    const used = new Set([...page.matchAll(/w\('(features-[a-z0-9-]+)'/g)].map((m) => m[1]));
    for (const r of REGISTRY) for (const k of ['name', 'short', 'benefit']) used.add(`features-${r.id}-${k}`);
    for (const r of REGISTRY) used.add(`features-cfg-${r.id}`);
    const r = features(ctxWith({ secrets: [OVH] }));
    for (const c of r.capabilities) if (c.suggestion) used.add(c.suggestion.say.key);
    for (const key of used) assert.ok(key in FEATURE_WORDS_FR, `${key} has no French`);
    assert.deepEqual(featureWords('en-US'), {});
    assert.equal(featureWords('fr-CA')['features-title'], 'Fonctions');
});
