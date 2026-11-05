/* THE KIT (web/kit.js): one implementation per gesture. Its pure parts (states, colours) read directly;
   its pieces drawn on a small stand-in for the page's document (no browser here); and the page
   checked to load it and to draw a conversation with it, nowhere by hand. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILES } from '../server/main.mjs';

const web = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

/* Just enough of a document for the kit: elements with classes, data, attributes, children, events. */
class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.className = ''; this.listeners = {}; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this.parent = null; this.text = ''; }
    set textContent(v) { this.children = []; this.text = String(v); }
    get textContent() { return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...kids) { for (const k of kids) { if (k && typeof k === 'object') k.parent = this; this.children.push(k); } }
    prepend(...kids) { for (const k of kids.reverse()) { if (k && typeof k === 'object') k.parent = this; this.children.unshift(k); } }
    replaceChildren(...kids) { this.children = []; this.text = ''; this.append(...kids); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    click() { for (const fn of this.listeners.click ?? []) fn({}); }
    get isConnected() { return Boolean(this.parent); }
    replaceWith(other) { const i = this.parent.children.indexOf(this); other.parent = this.parent; this.parent.children[i] = other; this.parent = null; }
    focus() { globalThis.document.activeElement = this; }
    get classes() { return this.className.split(/\s+/).filter(Boolean); }
    all(pred, out = []) { for (const c of this.children) if (typeof c === 'object') { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
    find(cls) { return this.all((n) => n.classes.includes(cls))[0] ?? null; }
}
globalThis.document = { createElement: (tag) => new Node(tag), activeElement: null };
const window = {};
new Function('window', web('kit.js'))(window);
const KIT = window.clavariumKit;

test('the states are the list\'s six, worst first; older names say the same states', () => {
    assert.deepEqual(KIT.STATES, ['problem', 'wait', 'work', 'busy', 'ok', 'sleep']);
    for (const s of KIT.STATES) assert.equal(typeof KIT.STATE_WORDS[s], 'string');
    assert.equal(KIT.stateOf('ready'), 'ok');
    assert.equal(KIT.stateOf('waits'), 'wait');
    assert.equal(KIT.stateOf('asleep'), 'sleep');
    assert.equal(KIT.stateOf('busy'), 'busy');
    assert.equal(KIT.stateOf('nonsense'), 'ok');
    /* Every state has its colour in the page's style, and no other. */
    const css = web('style.css');
    for (const s of ['problem', 'wait', 'work', 'busy', 'sleep']) assert.match(css, new RegExp(`\\.state-dot\\[data-state="${s}"\\]`), s);
});

test('a name has its colour, always the same, and its initial', () => {
    assert.equal(KIT.hueOf('Kitchen helper'), KIT.hueOf('Kitchen helper'));
    assert.notEqual(KIT.hueOf('Kitchen helper'), KIT.hueOf('Homework'));
    for (const n of ['a', 'Zoë', '', '日本', '🙂 smile']) { const h = KIT.hueOf(n); assert.ok(Number.isInteger(h) && h >= 0 && h < 360, n); }
    /* The same colour the rooms' members had before the kit (h * 31 + code point, mod 360). */
    let h = 0; for (const ch of 'Homework') h = (h * 31 + ch.codePointAt(0)) >>> 0;
    assert.equal(KIT.hueOf('Homework'), h % 360);
    assert.equal(KIT.initialOf('  kitchen'), 'K');
    assert.equal(KIT.initialOf(''), '?');
    assert.equal(KIT.initialOf(undefined), '?');
    assert.equal(KIT.initialOf('🙂 smile'), '🙂');
});

test('a point says its state, in the one vocabulary', () => {
    const d = KIT.StatusDot({ state: 'waits', label: 'waits for you' });
    assert.ok(d.classes.includes('state-dot'));
    assert.equal(d.dataset.state, 'wait');
    assert.equal(d.title, 'waits for you');
});

test('a switch is a switch: role, its state, its name, and it turns', () => {
    const seen = [];
    const s = KIT.Switch({ on: false, label: 'Homework in the room', onChange: (v) => seen.push(v) });
    assert.equal(s.getAttribute('role'), 'switch');
    assert.equal(s.getAttribute('aria-checked'), 'false');
    assert.equal(s.getAttribute('aria-label'), 'Homework in the room');
    s.click(); assert.equal(s.getAttribute('aria-checked'), 'true');
    s.click(); assert.deepEqual(seen, [true, false]);
});

test('a segmented choice presses the one chosen, and only it', () => {
    const seen = [];
    const g = KIT.Segmented({ options: [{ value: 'all', label: 'All' }, { value: 'rooms', label: 'Rooms only' }], value: 'all', label: 'Show', onChange: (v) => seen.push(v) });
    assert.equal(g.getAttribute('role'), 'group');
    const [a, b] = g.children;
    assert.deepEqual([a.getAttribute('aria-pressed'), b.getAttribute('aria-pressed')], ['true', 'false']);
    b.click();
    assert.deepEqual([a.getAttribute('aria-pressed'), b.getAttribute('aria-pressed')], ['false', 'true']);
    assert.deepEqual(seen, ['rooms']);
});

test('a confirmation takes the button\'s place: Keep first and focused, then the action; Keep puts the button back', async () => {
    const host = new Node('div'); const button = new Node('button'); host.append(button);
    let done = 0;
    const { element } = KIT.InlineConfirm(button, { question: 'Remove it?', yes: 'Remove', onYes: () => { done += 1; } });
    assert.equal(host.children[0], element);
    assert.equal(element.getAttribute('role'), 'alertdialog');
    const [keep, yes] = element.all((n) => n.tagName === 'BUTTON');
    assert.equal(keep.textContent, 'Keep');
    assert.equal(document.activeElement, keep);
    assert.ok(yes.classes.includes('danger'));
    yes.click(); await Promise.resolve();
    assert.equal(done, 1);
    keep.click();
    assert.equal(host.children[0], button);
});

const conv = { title: 'Kitchen helper', state: 'wait', stateLabel: 'waits for you', avatar: { name: 'Kitchen helper' }, when: '30 min', last: 'Leek quiche or soup?', now: '', who: 'Chef · OpenCode',
    chips: [{ text: 'asks you', tone: 'need', cls: 'needs-mark' }, { text: '1 wake-up', tone: 'note', cls: 'shared-mark' }, { text: 'Family room', icon: 'room', wide: true }] };
const chipsOf = (card) => card.all((n) => n.classes.includes('kit-chip')).map((n) => n.textContent);

test('one conversation, three sizes: the same avatar, point, name, line and chips; each place its gestures', () => {
    const row = KIT.ConvCard(conv, { size: 'row', cls: 'item' });
    const card = KIT.ConvCard(conv, { size: 'card', cls: 'conv-card' });
    const member = KIT.ConvCard(conv, { size: 'member', cls: 'salon-member-row', actions: [KIT.Switch({ label: 'in the room' })] });
    for (const [el, tag] of [[row, 'BUTTON'], [card, 'BUTTON'], [member, 'DIV']]) {
        assert.equal(el.tagName, tag);
        assert.ok(el.classes.includes('kit-conv'));
        /* The page's rules and tests find the point right under the row, the name in its only <b>. */
        const dot = el.children.find((c) => c.classes.includes('state-dot'));
        assert.equal(dot.dataset.state, 'wait');
        assert.equal(el.find('kit-av').textContent, 'K');
        assert.deepEqual(el.all((n) => n.tagName === 'B').map((b) => b.textContent), ['Kitchen helper']);
    }
    assert.ok(row.classes.includes('item'));
    assert.equal(row.find('when').textContent, '30 min');
    assert.equal(row.find('last').textContent, 'Leek quiche or soup?');
    /* Its room is said on a card; a member says only what waits for you. */
    assert.deepEqual(chipsOf(row), ['asks you', '1 wake-up']);
    assert.deepEqual(chipsOf(card), ['asks you', '1 wake-up', 'Family room']);
    assert.deepEqual(chipsOf(member), ['asks you']);
    assert.match(card.find('kit-conv-now').textContent, /Chef · OpenCode/);
    assert.equal(member.find('kit-conv-now').textContent, 'Chef · OpenCode');
    assert.equal(member.find('kit-conv-acts').children[0].getAttribute('role'), 'switch');
    /* Nothing to say: no empty line, no empty chips. */
    const quiet = KIT.ConvCard({ title: 'Homework', state: 'ok' }, { size: 'row' });
    assert.equal(quiet.find('kit-chips'), null);
    assert.equal(quiet.find('when'), null);
    let opened = 0; const open = KIT.ConvCard({ title: 'x' }, { size: 'card', onOpen: () => { opened += 1; } }); open.click(); assert.equal(opened, 1);
});

test('the pages load the kit before app.js, the server serves it, and app.js draws a conversation only with it', () => {
    assert.deepEqual(FILES['/kit.js'], ['web/kit.js', 'text/javascript; charset=utf-8']);
    for (const [page, kit, app] of [['index.html', '<script src="/kit.js">', '<script src="/app.js">'], ['device.html', '<script src="kit.js">', '<script src="app.js">']]) {
        const html = web(page);
        assert.ok(html.includes(kit), page);
        assert.ok(html.indexOf(kit) < html.indexOf(app), `${page}: the kit first`);
    }
    const app = web('app.js');
    for (const size of ['row', 'card', 'member']) assert.match(app, new RegExp(`KIT\\.ConvCard\\([^\\n]*size: '${size}'`), size);
    /* The hand-drawn copies are gone: the old card's plate and picture, the members' avatar, their switch. */
    assert.doesNotMatch(app, /conv-card-plate|conv-card-art|salon-av|'salon-switch'|className = 'state-dot'/);
    assert.match(app, /const statePoint = \(state\) => KIT\.StatusDot\(/);
});

test('steps: the done ones ticked, the one at hand marked, and where it is', () => {
    const f = KIT.StepFlow({ steps: ['Kind', 'Set up', 'Created'], at: 1, label: 'Steps' });
    const items = f.all((n) => n.tagName === 'LI');
    assert.equal(items.length, 3);
    assert.ok(items[0].classes.includes('done'));
    assert.equal(items[0].find('kit-step-n').textContent, '✓');
    assert.equal(items[1].getAttribute('aria-current'), 'step');
    assert.equal(items[2].getAttribute('aria-current'), null);
    assert.equal(f.find('kit-steps-count').textContent, '2 / 3');
    const end = KIT.StepFlow({ steps: ['Kind', 'Set up', 'Created'], at: 3 });
    assert.equal(end.all((n) => n.classes.includes('done')).length, 3);
    assert.equal(end.find('kit-steps-count').textContent, '3 / 3');
});

test('a key: its keys to choose, "+ New key…" opens a name in place, made and chosen', async () => {
    const made = [];
    const p = KIT.SecretPicker({ ids: { select: 'k', add: 'k-new', row: 'k-make', name: 'k-name', go: 'k-go' }, keys: [{ value: 'a', label: 'a (used by site)' }], none: 'No key yet', suggest: () => 'site',
        onMake: async (name) => { made.push(name); p.set([{ value: 'a' }, { value: name }], name); } });
    const byId = (id) => p.all((n) => n.id === id)[0];
    assert.equal(byId('k').children.length, 1);
    assert.equal(byId('k-make').hidden, true);
    byId('k-new').click();
    assert.equal(byId('k-make').hidden, false);
    assert.equal(byId('k-name').value, 'site');
    byId('k-go').click(); await new Promise((ok) => setTimeout(ok, 0));
    assert.deepEqual(made, ['site']);
    assert.equal(byId('k').value, 'site');
    assert.equal(byId('k-make').hidden, true);
    p.set([]);
    assert.equal(byId('k').children[0].textContent, 'No key yet');
});

test('new asset: one box -- its kinds, a form, one ending; its context on top', () => {
    const kinds = [{ kind: 'folder', label: 'Folder' }, { kind: 'git', label: 'Git repository' }];
    const seen = [];
    const there = new Node('div');
    const choose = KIT.NewAsset({ kinds, existing: there, context: { line: 'Will be attached to Homework' }, onKind: (k) => seen.push(k) });
    assert.equal(choose.dataset.step, 'kind');
    assert.equal(choose.find('kit-na-context').textContent, 'Will be attached to Homework');
    assert.ok(choose.children.includes(there), 'what is there already, in the box');
    const buttons = choose.find('as-kinds').children;
    assert.deepEqual(buttons.map((b) => b.dataset.kind), ['folder', 'git']);
    buttons[1].click(); assert.deepEqual(seen, ['git']);
    assert.equal(choose.all((n) => n.getAttribute('aria-current') === 'step')[0].textContent, '1Kind');
    const form = new Node('div');
    const filling = KIT.NewAsset({ kinds, kind: 'folder', form: () => form, context: { line: 'x', level: { options: [{ value: 'read' }, { value: 'write' }], value: 'write' } } });
    assert.equal(filling.dataset.step, 'form');
    assert.ok(filling.children.includes(form));
    assert.ok(filling.find('kit-seg'), 'the level, chosen in the context line');
    assert.equal(filling.find('kit-steps-count').textContent, '2 / 3');
    const ends = [];
    const done = KIT.NewAsset({ kinds, kind: 'folder', made: { said: 'seeds created' }, onAnother: () => ends.push('another'), onDone: () => ends.push('done') });
    assert.equal(done.dataset.step, 'done');
    assert.match(done.find('kit-na-made').textContent, /✓ seeds created/);
    for (const b of done.all((n) => n.tagName === 'BUTTON')) b.click();
    assert.deepEqual(ends, ['another', 'done']);
});

test('new asset: a kind of several steps (a voice box) says the one at hand', () => {
    const steps = ['Kind', 'Where', 'Plug it', 'Pair it', 'It answers'];
    const box = KIT.NewAsset({ kinds: [{ kind: 'box', label: 'Voice box' }], kind: 'box', at: 3, form: () => new Node('div'), words: { steps } });
    assert.equal(box.find('kit-steps-count').textContent, '4 / 5');
    assert.equal(box.all((n) => n.getAttribute('aria-current') === 'step')[0].textContent, '4Pair it');
    const answered = KIT.NewAsset({ kinds: [], kind: 'box', at: 3, made: { said: 'Kitchen answers in Homework' }, words: { steps } });
    assert.equal(answered.dataset.step, 'done');
    assert.equal(answered.find('kit-steps-count').textContent, '5 / 5');
});

test('a voice box and a device are kinds of the one box; every way in opens it, and the box is paired as before', () => {
    const app = web('app.js'); const html = web('index.html');
    assert.match(app, /\['box', uiSaid\('set-na-k-box', 'Voice box'\)\], \['device', uiSaid\('set-na-k-device', 'Device'\)\]/);
    /* One pairing code for every caller, the same request as before. */
    assert.equal((app.match(/\/boxes\/code/g) ?? []).length, 1, 'one place asks for a pairing code');
    assert.match(app, /function pairCode\(/);
    /* One new device, for every way in. */
    assert.equal((app.match(/openCompose\(accessFor/g) ?? []).length, 0);
    for (const id of ['map-new-device', 'share-new-device']) assert.match(app, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('click', \\(\\) => newDevice\\(accessFor\\)\\)`), id);
    /* Its form, steps one at a time, keeps the names the page knew. */
    for (const id of ['box-new', 'box-newasset', 'box-add', 'box-conversation', 'box-room', 'box-code', 'box-ready', 'box-qr', 'box-link', 'box-key', 'box-code-shown', 'salon-new-box-add']) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('the page makes every asset with the one box, and gives its git key with the SecretPicker', () => {
    const app = web('app.js'); const html = web('index.html');
    assert.equal((app.match(/KIT\.NewAsset\(/g) ?? []).length, 1, 'one place draws it');
    assert.match(app, /KIT\.SecretPicker\(/);
    /* Gone: the kinds drawn by hand, the second way to attach. */
    assert.doesNotMatch(app, /el\('div', 'as-kinds'\)/);
    assert.doesNotMatch(html, /id="access-assets-here"/);
    /* One verb for the forms' main button. */
    for (const form of ['folder-new', 'git-new', 'mailbox-new', 'list-new', 'secret-new']) {
        const part = html.slice(html.indexOf(`id="${form}"`), html.indexOf('</form>', html.indexOf(`id="${form}"`)));
        assert.match(part, /<button type="submit" class="primary">Create<\/button>/, form);
    }
});
