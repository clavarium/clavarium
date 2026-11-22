/* DELEGATED SIGN-IN (15-11, #362): a tool's sign-in link handed to another conversation (its companion),
   which opens it in its browser and gives the code back; the code typed into the tool, once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, JsonFile } from '../server/store.mjs';
import { Dockets } from '../server/dockets.mjs';
import { SigninHelp, KIND, WAIT_MS, linkAllowed } from '../server/signinhelp.mjs';
import { loadTools, readTools, screenRules } from '../server/tools.mjs';
import { rulesFor, actionsOn, Relay, HAND_MS } from '../config/launch/screen-watch.mjs';
import { packageFile } from '../server/parley.mjs';

const { run: docket } = await import(pathToFileURL(packageFile('clavarium-docket', 'bin/docket.mjs')).href);
const settle = () => new Promise((r) => { setTimeout(r, 80); });
const LINK = 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=abc';
const CODE = 'abcDEF123_code#state-xyz';

function bench(t, { names = ['alpha', 'beta', 'gamma'] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-signin-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = (name) => join(dir, 'work', name);
    for (const n of names) mkdirSync(join(work(n), '.parley'), { recursive: true });
    const world = { now: Date.parse('2026-11-15T10:00:00.000Z'), awake: [...names], chat: new Set(names), browsers: { alpha: 'free', beta: 'free', gamma: 'free' }, types: true };
    const tools = [
        { id: 'claude-code', label: 'Claude Code', signin: { senders: ['claude.ai'], links: ['claude.ai', 'claude.com'], screen: ['link:https://claude\\.ai/\\S*oauth\\S*', 'code:Paste code here'] } },
        { id: 'codex', label: 'Codex CLI', signin: { senders: ['openai.com'], links: ['openai.com'], screen: ['link:https://auth\\.openai\\.com/\\S+'] } },
    ];
    const conversations = names.map((name) => ({ name, tool: name === 'gamma' ? 'codex' : 'claude-code' }));
    const typed = []; const lines = [];
    let help;
    const dockets = new Dockets({ store: new Store(join(dir, 'dockets.json')), resources: { workFolder: work }, now: () => world.now, listenEveryMs: 10,
        say: async () => true, event: (name, line) => lines.push([name, line.kind, line.text]), awake: () => world.awake, chatOn: (n) => world.chat.has(n),
        acked: (name, e) => help.acked(name, e) });
    t.after(() => dockets.stop());
    help = new SigninHelp({ store: new JsonFile(join(dir, 'companion.json'), {}), conversations: () => conversations, tools: () => tools,
        awake: () => world.awake, chatOn: (n) => world.chat.has(n), workFolder: work,
        browsers: (n) => (world.browsers[n] ? [{ id: 'browser-test', level: world.browsers[n] }] : []),
        post: (n, e) => dockets.post(n, e), type: async (n, text) => { typed.push([n, text]); return world.types; },
        event: (n, line) => lines.push([n, line.kind, line.text, line.actions]), now: () => world.now });
    /* What screen-watch writes in the asking machine, and reads back. */
    const ask = (name, extra = {}) => { const id = `${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-000000000000`; writeFileSync(join(work(name), '.parley', 'signin-ask.json'), JSON.stringify({ id, at: new Date(world.now).toISOString(), link: LINK, around: '', ...extra })); return id; };
    const route = (name) => { try { return JSON.parse(readFileSync(join(work(name), '.parley', 'signin-route.json'), 'utf8')); } catch { return null; } };
    /* The companion's agent, in its machine: the docket command. */
    const tool = (name, ...args) => docket(args, { cwd: work(name), env: { DOCKET_TZ: '', DOCKET_DIR: '', TZ: 'UTC' }, now: () => world.now });
    const waiting = (name) => dockets.of(name).events.filter((e) => e.kind === KIND && e.state === 'waiting');
    return { dir, work, world, help, dockets, typed, lines, ask, route, tool, waiting };
}

test('the rules of each tool are those of config/tools.json, its launcher\'s the fallback (15-11)', () => {
    const tools = loadTools();
    const file = JSON.parse(JSON.stringify(screenRules(tools)));
    assert.deepEqual(Object.keys(file).sort(), ['claude-code', 'codex', 'opencode', 'vibe']);
    const launcher = ['link:https://old\\.example\\.com/\\S+', 'notice:restart=Restart when it suits you.'];
    const rules = rulesFor(['--tool', 'claude-code', ...launcher], file);
    assert.deepEqual(rules.map((r) => r.kind), ['type', 'keys', 'link', 'code', 'notice'], 'its own sign-in rules, the launcher\'s notice kept');
    assert.deepEqual(rulesFor(['--tool', 'nope', ...launcher], file).map((r) => r.kind), ['link', 'notice'], 'no rules for it: the launcher\'s');
    assert.deepEqual(rulesFor(launcher, null).map((r) => r.kind), ['link', 'notice'], 'an older launcher, no --tool');
    /* Claude Code's real screen (02-11, 15-11): signed out, its method, its link, its code. */
    const kinds = (screen) => actionsOn(screen, rules, new Set()).map((a) => a.kind);
    assert.deepEqual(kinds('⎿ Login expired · Please run /login'), ['type']);
    assert.deepEqual(kinds(' Select login method:\n ❯ 1. Claude account with subscription'), ['keys']);
    assert.deepEqual(kinds(` Browser didn't open? Use the url below to sign in:\n${LINK}\n Paste code here if prompted >`), ['link', 'code']);
    /* Every link rule's links lie in its declared domains. */
    for (const t of tools.filter((x) => x.signin?.screen)) assert.ok(t.signin.links.length, t.id);
    const one = (screen) => readTools(JSON.stringify([{ id: 'x', label: 'X', command: ['x'], memoryMb: 768, install: [], signin: { senders: ['example.com'], links: ['example.com'], screen } }]));
    assert.deepEqual(one(['link:https://example\\.com/\\S+'])[0].signin.screen, ['link:https://example\\.com/\\S+']);
    for (const bad of [[], ['notice:x=y'], ['link:('], ['nope:x'], 'link:x', [1]]) assert.throws(() => one(bad), /screen/, JSON.stringify(bad));
});

test('screen-watch: a link handed over is not told; told to the person when the server says so, or says nothing', () => {
    let route = null; let now = 0;
    const relay = new Relay({ route: () => route, now: () => now, id: () => 'id-1' });
    const link = { match: LINK, around: '' };
    assert.deepEqual(relay.link(link).map((e) => e.do), ['ask'], 'asked, not told');
    assert.deepEqual(relay.code(), [], 'the person is not asked to paste');
    route = { id: 'id-1', route: 'companion', companion: 'beta' };
    assert.deepEqual(relay.step(), []);
    route = { id: 'id-1', route: 'person' };
    const back = relay.step();
    assert.deepEqual(back.map((e) => e.do), ['ask', 'tell-link', 'arm', 'tell-paste'], 'given back: the link told, the code awaited from the chat');
    assert.equal(back[0].ask.told, true, 'the ask says it was told, so that a late server hands it to nobody');
    assert.deepEqual(relay.step(), [], 'once');
    /* A server that never answers (older): the person, after HAND_MS. */
    const silent = new Relay({ route: () => null, now: () => now, id: () => 'id-2' });
    silent.link(link);
    now += HAND_MS - 1; assert.deepEqual(silent.step(), []);
    now += 2; assert.deepEqual(silent.step().map((e) => e.do), ['ask', 'tell-link']);
    assert.deepEqual(silent.code().map((e) => e.do), ['arm', 'tell-paste']);
    /* Done: the code was typed by the server; nothing more. */
    const done = new Relay({ route: () => ({ id: 'id-3', route: 'done' }), id: () => 'id-3' });
    done.link(link); assert.deepEqual(done.step(), []);
    assert.deepEqual(done.code().map((e) => e.do), ['arm', 'tell-paste'], 'a new screen asking for a code after it: the person, as before');
    /* No chat folder: told at once, as before. */
    assert.deepEqual(new Relay({ chat: () => false }).link(link).map((e) => e.do), ['tell-link']);
});

test('routing: the general companion, none, never itself, crossed companions and the last one signed in', async (t) => {
    const b = bench(t);
    /* None set: the person. */
    b.ask('alpha'); await b.help.tick();
    assert.equal(b.route('alpha').route, 'person');
    /* The general one. */
    b.help.setGeneral('beta');
    const id = b.ask('alpha'); await b.help.tick();
    assert.deepEqual(b.route('alpha'), { id, route: 'companion', companion: 'beta' });
    const [e] = b.waiting('beta');
    assert.ok(e, 'posted to the companion\'s docket');
    assert.doesNotMatch(e.text, /claude\.ai/, 'the link is not in the event');
    assert.match(e.text, /tether browser browser-test open "\$\(head -n1 \/work\/\.docket\/signin-\w{8}\.txt\)"/);
    assert.match(e.text, /Click Authorize in your browser/);
    const file = readdirSync(join(b.work('beta'), '.docket')).find((n) => n.startsWith('signin-'));
    assert.equal(readFileSync(join(b.work('beta'), '.docket', file), 'utf8').split('\n')[0], LINK, 'the link in its docket folder only');
    assert.deepEqual(b.lines.find((l) => l[0] === 'alpha').slice(1), [KIND, 'Signing in through « beta »…', ['signinlink']]);
    assert.ok(!JSON.stringify(b.lines).includes('claude.ai'), 'never in a chat line');
    assert.equal(b.help.companionFor('beta'), null, 'the general one never serves itself');
    /* Its own, none. */
    assert.throws(() => b.help.setFor('alpha', 'alpha'), /cannot sign itself in/);
    b.help.setFor('gamma', 'none');
    assert.equal(b.help.companionFor('gamma'), null);
    /* Crossed: alpha -> beta, beta -> gamma, gamma -> alpha. */
    b.help.setGeneral('');
    b.help.setFor('alpha', 'beta'); b.help.setFor('beta', 'gamma'); b.help.setFor('gamma', 'alpha');
    assert.equal(b.help.companionFor('beta'), 'gamma');
    assert.equal(b.help.companionFor('gamma'), 'beta', 'alpha signs in itself (it waits for beta): another companion that can, never itself');
    /* The last one signed in serves the others. */
    b.world.awake = ['alpha', 'beta'];
    assert.equal(b.help.companionFor('beta'), null, 'gamma asleep, alpha signing in itself: nobody');
    b.world.awake = ['alpha', 'beta', 'gamma'];
    b.world.browsers.gamma = 'watch';
    assert.equal(b.help.companionFor('beta'), null, 'a browser it may only watch: cannot open the link');
    b.world.browsers.gamma = 'propose';
    assert.equal(b.help.companionFor('beta'), 'gamma', 'one that asks the person each time is enough');
    assert.deepEqual(b.help.view().browsers, { beta: ['browser-test'], gamma: ['browser-test'], alpha: ['browser-test'] });
});

test('a link to anywhere else, or told already, is handed to nobody', async (t) => {
    const b = bench(t);
    b.help.setGeneral('beta');
    assert.equal(linkAllowed('https://evil.example.com/claude.ai', ['claude.ai']), false);
    assert.equal(linkAllowed('http://claude.ai/oauth', ['claude.ai']), false);
    assert.equal(linkAllowed('https://someone@example.com/oauth', ['example.com']), false, 'no user part');
    assert.equal(linkAllowed('https://www.claude.ai/oauth', ['claude.ai']), true);
    b.ask('alpha', { link: 'https://evil.example.com/oauth' }); await b.help.tick();
    assert.equal(b.route('alpha').route, 'person');
    b.ask('alpha', { told: true }); await b.help.tick();
    assert.deepEqual(b.waiting('beta'), [], 'nothing posted');
});

test('the companion\'s code is typed into the asking tool, once, and never shown', async (t) => {
    const b = bench(t);
    b.help.setGeneral('beta');
    const id = b.ask('alpha'); await b.help.tick();
    const [e] = b.waiting('beta');
    assert.match(b.tool('beta', 'done', e.id.slice(0, 8), CODE).out, /^Done/);
    await settle();
    assert.deepEqual(b.typed, [['alpha', CODE]], 'typed once');
    assert.deepEqual(b.route('alpha'), { id, route: 'done' });
    assert.ok(b.lines.some((l) => l[0] === 'alpha' && l[2] === 'Signed in through « beta ».'));
    assert.ok(!JSON.stringify(b.lines).includes(CODE), 'the code in no chat line');
    assert.equal(b.dockets.of('beta').events.find((x) => x.id === e.id).note, '(not shown)', 'nor in its owner\'s view');
    assert.ok(!readdirSync(join(b.work('beta'), '.docket')).some((n) => n.startsWith('signin-')), 'the link taken away');
    /* The same ask read again: nothing more. */
    await b.help.tick(); await b.help.acked('beta', { event: e, ack: { kind: 'done', note: CODE } });
    assert.equal(b.typed.length, 1);
    /* A tool that awaits no code (it polls): "ok" is enough. */
    b.help.setFor('gamma', 'beta');
    b.ask('gamma', { link: 'https://auth.openai.com/codex/device' }); await b.help.tick();
    const [g] = b.waiting('beta');
    b.tool('beta', 'done', g.id.slice(0, 8), 'ok'); await settle();
    assert.equal(b.route('gamma').route, 'done');
    assert.equal(b.typed.length, 1, 'nothing typed');
});

test('no code, a failure, no answer in time, or the person asking: the link goes to the person', async (t) => {
    const b = bench(t);
    b.help.setGeneral('beta');
    const next = async () => { b.ask('alpha'); await b.help.tick(); return b.waiting('beta')[0]; };  /* newest first */
    let e = await next();
    b.tool('beta', 'done', e.id.slice(0, 8), 'opened it, the page says nothing'); await settle();
    assert.equal(b.route('alpha').route, 'person');
    assert.deepEqual(b.typed, [], 'not a code: nothing typed');
    e = await next();
    b.tool('beta', 'failed', e.id.slice(0, 8), 'the browser is not connected'); await settle();
    assert.equal(b.route('alpha').route, 'person');
    assert.ok(b.lines.some((l) => l[0] === 'alpha' && /could not sign it in \(the browser is not connected\)/.test(l[2])));
    e = await next();
    b.world.now += WAIT_MS + 1; await b.help.tick();
    assert.equal(b.route('alpha').route, 'person');
    assert.ok(b.lines.some((l) => l[0] === 'alpha' && /did not answer in 10 minutes/.test(l[2])));
    /* Its answer, late: nothing typed. */
    b.tool('beta', 'done', e.id.slice(0, 8), CODE); await settle();
    assert.deepEqual(b.typed, []);
    await next();
    assert.deepEqual(b.help.showLink('alpha'), { ok: true });
    assert.equal(b.route('alpha').route, 'person');
    assert.throws(() => b.help.showLink('alpha'), /No sign-in is waiting/);
    /* The code that could not be typed: the person too. */
    e = await next(); b.world.types = false;
    b.tool('beta', 'done', e.id.slice(0, 8), CODE); await settle();
    assert.equal(b.route('alpha').route, 'person');
    assert.deepEqual(readdirSync(join(b.work('beta'), '.docket')).filter((n) => n.startsWith('signin-')), [], 'no link left in its folder');
});

/* Its owner's go (15-11): the companion clicks Authorize itself; off unless said. */
test('the companion clicks Authorize itself only when its owner allowed it', async (t) => {
    const b = bench(t);
    b.help.setGeneral('beta');
    assert.equal(b.help.view().clicks, false, 'off unless said');
    assert.throws(() => b.help.setClicks('yes'), /true or false/);
    b.help.setClicks(true);
    b.ask('alpha'); await b.help.tick();
    const [e] = b.waiting('beta');
    assert.match(e.text, /Your owner allowed you: on that page only, click the button that authorizes/);
    assert.doesNotMatch(e.text, /Click Authorize in your browser/);
    assert.equal(b.help.view().clicks, true);
});

test("a code the person pastes while their tool waits for it is that code, not a secret; else, a secret as before (20-11, #394)", async (t) => {
    const b = bench(t);
    assert.equal(b.help.awaitsCode('alpha', CODE), false, 'no ask: nothing awaited');
    b.ask('alpha', { told: true });
    assert.equal(b.help.awaitsCode('alpha', CODE), true, 'told to the person: the code awaited');
    assert.equal(b.help.awaitsCode('alpha', `${CODE} and more words`), false, 'a message with more than a code');
    assert.equal(b.help.awaitsCode('beta', CODE), false, 'another conversation');
    b.world.now += 31 * 60_000;
    assert.equal(b.help.awaitsCode('alpha', CODE), false, 'asked too long ago');
    /* Routed to the person by the server (no companion): awaited too; handed to a companion: not the person's. */
    b.ask('alpha'); await b.help.tick();
    assert.equal(b.route('alpha').route, 'person');
    assert.equal(b.help.awaitsCode('alpha', CODE), true);
    b.help.setGeneral('beta'); b.ask('alpha'); await b.help.tick();
    assert.equal(b.route('alpha').route, 'companion');
    assert.equal(b.help.awaitsCode('alpha', CODE), false);
});

test('at its code prompt nothing may be typed: asked of its screen, only while a sign-in is open and its tool has such a prompt', async (t) => {
    const b = bench(t);
    const screen = (text, code = 0) => async () => ({ code, stdout: text, stderr: '' });
    const prompt = 'Paste code here if prompted >';
    assert.equal(await b.help.atCodePrompt('alpha', screen(prompt)), false, 'no sign-in open');
    b.ask('alpha');
    assert.equal(await b.help.atCodePrompt('alpha', screen(prompt)), true);
    assert.equal(await b.help.atCodePrompt('alpha', screen('> ready')), false, 'signed in: its screen moved on');
    assert.equal(await b.help.atCodePrompt('alpha', screen(prompt, 1)), false, 'its screen could not be read');
    b.ask('gamma');
    assert.equal(await b.help.atCodePrompt('gamma', screen(prompt)), false, 'a tool without a code prompt');
    b.world.now += 31 * 60_000;
    assert.equal(await b.help.atCodePrompt('alpha', screen(prompt)), false, 'after its time: never held for ever');
});
