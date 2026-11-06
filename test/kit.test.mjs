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
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    click() { for (const fn of this.listeners.click ?? []) fn({}); }
    get isConnected() { return Boolean(this.parent); }
    replaceWith(other) { const i = this.parent.children.indexOf(this); other.parent = this.parent; this.parent.children[i] = other; this.parent = null; }
    focus() { globalThis.document.activeElement = this; }
    get classes() { return this.className.split(/\s+/).filter(Boolean); }
    all(pred, out = []) { for (const c of this.children) if (typeof c === 'object') { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
    find(cls) { return this.all((n) => n.classes.includes(cls))[0] ?? null; }
}
globalThis.document = { createElement: (tag) => new Node(tag), createElementNS: (ns, tag) => new Node(tag), activeElement: null };
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
    /* A card leaves its tool to the details (06-11, the owner's tablet); a member keeps it. */
    assert.equal(card.find('kit-conv-now'), null);
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

test('who takes it: machines the largest first, at most six, the rest folded into Others; then the system, then what is free', () => {
    const parts = [3, 9, 1, 7, 5, 2, 8, 4].map((mb, i) => ({ key: `m${i}`, label: `M${i}`, mb }));
    parts.push({ key: 'zero', label: 'Z', mb: 0 }, { key: 'nan', label: 'N', mb: Number.NaN });
    const slots = new Map();
    const s = KIT.shareSlices(parts, { restMb: 10, freeMb: 50, slots });
    assert.deepEqual(s.map((x) => x.key), ['m1', 'm6', 'm3', 'm4', 'm7', 'm0', 'others', 'rest', 'free']);
    assert.deepEqual(s.map((x) => x.mb), [9, 8, 7, 5, 4, 3, 3, 10, 50]);
    const others = s.find((x) => x.key === 'others');
    assert.equal(others.slot, 0); assert.deepEqual(others.keys, ['m5', 'm2']); assert.equal(others.label, 'Others');
    assert.deepEqual(s.slice(0, 6).map((x) => x.slot), [1, 2, 3, 4, 5, 6]);
    assert.equal(s.find((x) => x.key === 'rest').slot, 'rest'); assert.equal(s.find((x) => x.key === 'free').slot, 'free');
    assert.ok(Math.abs(s.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
    assert.equal(s.find((x) => x.key === 'free').share, 50 / 99);
    /* A colour follows its machine, never its rank: m3 grows to the top, keeps its colour; a newcomer takes a free one. */
    const again = KIT.shareSlices([{ key: 'm3', label: 'M3', mb: 20 }, { key: 'm1', label: 'M1', mb: 9 }, { key: 'new', label: 'New', mb: 1 }], { slots });
    assert.deepEqual(again.map((x) => [x.key, x.slot]), [['m3', 3], ['m1', 1], ['new', 2]]);
    /* Nothing running: only the system and what is free; no Others; nothing at all, nothing drawn. */
    assert.deepEqual(KIT.shareSlices([], { restMb: 2, freeMb: 6 }).map((x) => x.key), ['rest', 'free']);
    assert.deepEqual(KIT.shareSlices([], {}), []);
    /* Six exactly: no Others. Words given: used. */
    const six = KIT.shareSlices(parts.slice(0, 6), { freeMb: 1, words: { free: 'Libre' } });
    assert.ok(!six.some((x) => x.key === 'others')); assert.equal(six.at(-1).label, 'Libre');
});

test('the donut: one arc a slice, its length its share, the main figure in its middle, a slice under the finger', () => {
    const slices = KIT.shareSlices([{ key: 'a', label: 'Alpha', mb: 2048 }], { restMb: 1024, freeMb: 1024 });
    const donut = KIT.ShareDonut({ slices, label: 'Memory by machine', fmt: (mb) => `${mb / 1024} GB`, center: { top: 'Used', main: '3 GB', sub: 'of 4 GB' } });
    const svg = donut.children[0];
    const arcs = donut.all((n) => n.attributes.class === 'share-arc');
    assert.deepEqual(arcs.map((x) => x.dataset.s), ['1', 'rest', 'free']);
    const C = 2 * Math.PI * 40;
    /* Half, a quarter, a quarter: each less the gap between slices, each starting where the one before ended. */
    assert.deepEqual(arcs.map((x) => Number(x.getAttribute('stroke-dasharray').split(' ')[0])), [C / 2 - 1.2, C / 4 - 1.2, C / 4 - 1.2].map((v) => Number(v.toFixed(2))));
    assert.deepEqual(arcs.map((x) => Number(x.getAttribute('stroke-dashoffset'))), [0, -C / 2, (-3 * C) / 4].map((v) => Number(v.toFixed(2))));
    assert.equal(svg.getAttribute('aria-label'), 'Memory by machine: Alpha 2 GB 50 %; System and others 1 GB 25 %; Free 1 GB 25 %');
    const mid = donut.find('share-mid');
    assert.equal(mid.textContent, 'Used3 GBof 4 GB');
    arcs[1].click();
    assert.equal(mid.textContent, 'System and others1 GB25 %');
    assert.equal(arcs[1].getAttribute('data-on'), 'true'); assert.equal(arcs[0].getAttribute('data-on'), 'false');
    /* The same slice again: the main figure back. */
    arcs[1].click();
    assert.equal(mid.textContent, 'Used3 GBof 4 GB');
    assert.equal(KIT.ShareKey(3).dataset.s, '3');
});

/* THE TOP BAR (06-11): one bar atop every page of the right pane, two variants. */
const kids = (n) => n.children.filter((c) => typeof c === 'object');
test('top bar, main: the fold, its dot, its title with its line under it, its views on the right; its "‹" first', () => {
    let folded = 0;
    const views = document.createElement('div'); views.className = 'views';
    const who = document.createElement('button'); who.id = 'salon-who';
    const bar = KIT.TopBar({ variant: 'main', fold: true, onFold: () => { folded += 1; }, back: { label: 'Back', said: 'set-back' }, state: { id: 'salon-state', state: 'working' }, title: 'Family room', sub: ['2 AIs', who], actions: [views] });
    assert.equal(bar.tagName, 'HEADER');
    assert.deepEqual(bar.classes.slice(0, 2), ['topbar', 'kit-topbar']);
    assert.equal(bar.dataset.variant, 'main');
    const [fold, back, dot, head, right] = kids(bar);
    assert.ok(fold.classes.includes('fold-here') && fold.classes.includes('topbar-fold'));
    assert.equal(fold.textContent, '«'); assert.equal(fold.getAttribute('aria-pressed'), 'false');
    fold.click(); assert.equal(folded, 1);
    /* Main: the way back is its sign alone, before the dot (shown on a narrow screen); its words its name. */
    assert.equal(back.className, 'topbar-lead-back'); assert.equal(back.textContent, '‹');
    assert.equal(back.getAttribute('aria-label'), 'Back'); assert.equal(back.dataset.saidLabel, 'set-back');
    assert.equal(dot.id, 'salon-state'); assert.equal(dot.dataset.state, 'work'); assert.ok(dot.classes.includes('topbar-dot'));
    assert.equal(head.className, 'topbar-title');
    assert.equal(head.find('topbar-name').textContent, 'Family room');
    const line = head.find('topbar-sub'); assert.ok(line.textContent.startsWith('2 AIs')); assert.ok(line.children.includes(who));
    assert.equal(right.className, 'bar-right'); assert.deepEqual(kids(right), [views]);
});

test('top bar, sub: no dot without a state, the page\'s own elements kept (ids, classes), its way back last, its words its key\'s', () => {
    const fold = document.createElement('button'); fold.id = 'fold';
    const title = document.createElement('b'); title.id = 'settings-title'; title.textContent = 'Settings';
    const close = document.createElement('button'); close.id = 'settings-close'; close.textContent = '‹ Conversations';
    const search = document.createElement('input');
    const bar = KIT.TopBar({ variant: 'sub', fold, title, back: { element: close, label: 'Conversations', said: 'set-back-convs' }, actions: [search], cls: 'access-top' });
    assert.equal(bar.dataset.variant, 'sub'); assert.ok(bar.classes.includes('access-top'));
    const parts = kids(bar);
    assert.equal(parts.length, 3, 'fold, title, right: no dot, no back on the left');
    assert.equal(parts[0], fold); assert.equal(fold.id, 'fold'); assert.ok(fold.classes.includes('topbar-fold'));
    assert.equal(parts[1].find('topbar-name'), title); assert.equal(title.id, 'settings-title');
    const right = parts[2]; assert.deepEqual(kids(right), [search, close]);
    assert.equal(close.id, 'settings-close');
    assert.deepEqual(close.classes, ['as-link', 'place-back', 'topbar-back']);
    assert.equal(close.textContent, '‹ Conversations');
    assert.equal(close.find('topbar-back-label').dataset.said, 'set-back-convs');
    /* Its default words: "Back"; any other variant is 'main'; the page's own dot kept as it is. */
    const own = document.createElement('span'); own.id = 'state';
    const other = KIT.TopBar({ variant: 'nonsense', state: own, back: {} , title: 'x' });
    assert.equal(other.dataset.variant, 'main');
    assert.equal(kids(other)[1], own); assert.equal(own.id, 'state');
    assert.equal(kids(other)[0].getAttribute('aria-label'), 'Back');
    assert.equal(KIT.TopBar({ variant: 'sub', back: {}, title: 'x' }).find('topbar-back-label').textContent, 'Back');
});

test('every top bar of the page is the kit\'s: no header drawn by hand, the old strip gone', () => {
    const app = web('app.js');
    assert.match(app, /KIT\.TopBar\(\{\s*variant,/);
    assert.equal((app.match(/KIT\.TopBar\(/g) ?? []).length, 3, 'the places\', a conversation\'s, a device\'s');
    assert.doesNotMatch(app, /createElement\('header'\)/);
    assert.match(web('style.css'), /header\.topbar \{[^}]*height: 52px/);
});

/* ---------- ASSETS, step 1 (06-11): AssetIcon, AssetCard, the rights' one table, RightsBadge, RightsPicker ---------- */
const sameFills = (a, b) => assert.deepEqual([...a.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), [...b.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());

test('the rights: one table by kind and holder, "none" first everywhere; the same sets the page offers today', () => {
    for (const [key, cols] of Object.entries(KIT.RIGHTS)) {
        for (const [holder, levels] of Object.entries(cols)) {
            assert.equal(levels[0], 'none', `${key}/${holder}`);
            assert.ok(levels.length >= 2, `${key}/${holder}`);
            for (const l of levels) assert.ok(l in KIT.RIGHT_LEVELS, `${key}/${holder}: ${l}`);
        }
    }
    /* app.js levelOptionsFor and the "Used by" options, today: a live link five levels, a secret off/use, a mailbox read, the rest read/write. */
    const app = web('app.js');
    assert.ok(app.includes("[['none', 'Off'], ['watch', 'Watch'], ['propose', 'Propose'], ['frame', 'Frame'], ['free', 'Free']]"));
    assert.deepEqual(KIT.rightsFor('connexion'), ['none', 'watch', 'propose', 'frame', 'free']);
    assert.deepEqual(KIT.rightsFor('secret'), ['none', 'use']);
    assert.deepEqual(KIT.rightsFor('mailbox'), ['none', 'read']);
    for (const k of ['folder', 'git', 'list']) assert.deepEqual(KIT.rightsFor(k), ['none', 'read', 'write'], k);
    /* A device (levelControl, partsControl): a folder or a repository to read or write, a conversation in parts; a secret, never. */
    assert.deepEqual(KIT.rightsFor('folder', 'device'), ['none', 'read', 'write']);
    assert.deepEqual(KIT.rightsFor('conversation', 'device'), ['none', 'terminal', 'chat', 'both']);
    assert.deepEqual(KIT.rightsFor('secret', 'device'), []);
    assert.deepEqual(KIT.rightsFor('nonsense'), []);
    /* A live link is a connexion, whatever it links; the lightest real level is what "give the group" gives (giveValue). */
    assert.equal(KIT.rightsKey({ kind: 'agenda', live: true }), 'connexion');
    assert.equal(KIT.rightsKey({ kind: 'mailbox', target: { id: 'mail-x' } }), 'connexion');
    assert.equal(KIT.rightsKey({ kind: 'mailbox' }), 'mailbox');
    assert.deepEqual(['connexion', 'secret', 'folder', 'list', 'mailbox'].map((k) => KIT.lightest(k)), ['watch', 'use', 'read', 'read', 'read']);
});

test('the rights as the server keeps them, and back: off and nothing are none; a device\'s r / rw / x / rwx', () => {
    for (const v of [undefined, null, '', 'off', 'none']) assert.equal(KIT.rightOf('folder', v), 'none', String(v));
    assert.equal(KIT.rightOf('secret', 'use'), 'use');
    assert.equal(KIT.rightOf('connexion', 'frame'), 'frame');
    assert.equal(KIT.rightOf('folder', 'write'), 'write');
    assert.equal(KIT.rightOf('folder', 'r', 'device'), 'read');
    assert.equal(KIT.rightOf('git', 'rw', 'device'), 'write');
    assert.deepEqual(['x', 'rw', 'rwx'].map((v) => KIT.rightOf('conversation', v, 'device')), ['terminal', 'chat', 'both']);
    assert.equal(KIT.rightOf('folder', 'nonsense'), 'none');
    assert.equal(KIT.storedOf('secret', 'none'), 'off');
    assert.equal(KIT.storedOf('secret', 'use'), 'use');
    assert.equal(KIT.storedOf('list', 'none'), 'none');
    assert.equal(KIT.storedOf('connexion', 'propose'), 'propose');
    assert.deepEqual(['none', 'read', 'write'].map((l) => KIT.storedOf('folder', l, 'device')), [null, 'r', 'rw']);
    assert.deepEqual(['terminal', 'chat', 'both'].map((l) => KIT.storedOf('conversation', l, 'device')), ['x', 'rw', 'rwx']);
    /* Each level and back again, for every column of the table. */
    for (const [key, cols] of Object.entries(KIT.RIGHTS)) for (const [holder, levels] of Object.entries(cols)) for (const l of levels) {
        assert.equal(KIT.rightOf(key, KIT.storedOf(key, l, holder), holder), l, `${key}/${holder}/${l}`);
    }
});

test('a right, read: its word, its tone, its line; as kept or as a level', () => {
    const w = KIT.RightsBadge({ level: 'write' });
    assert.ok(w.classes.includes('kit-rights'));
    assert.equal(w.textContent, 'Writes'); assert.equal(w.dataset.tone, 'w'); assert.equal(w.title, 'Reads and writes');
    assert.equal(KIT.RightsBadge({ key: 'secret', value: 'use' }).textContent, 'Uses');
    assert.equal(KIT.RightsBadge({ key: 'secret', value: 'off' }).dataset.level, 'none');
    assert.equal(KIT.RightsBadge({ key: 'folder', value: 'r', holder: 'device' }).dataset.tone, 'r');
    assert.equal(KIT.RightsBadge({ level: 'watch' }).dataset.tone, 'x');
    assert.equal(KIT.RightsBadge({ level: 'nonsense' }).textContent, 'None');
});

test('a right, set: the kind\'s levels, None first, the one held pressed; it waits while the page works, and goes back if refused', async () => {
    const seen = [];
    const p = KIT.RightsPicker({ key: 'folder', value: 'read', label: 'reports for Kitchen helper', onChange: async (l, s) => { seen.push([l, s]); } });
    assert.ok(p.classes.includes('kit-rights-pick') && p.classes.includes('kit-seg'));
    assert.deepEqual(p.children.map((b) => b.textContent), ['None', 'Read', 'Write']);
    assert.deepEqual(p.children.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
    assert.equal(p.getAttribute('aria-label'), 'reports for Kitchen helper');
    assert.equal(p.children[2].title, 'Reads and writes');
    p.children[2].click(); await new Promise((ok) => setTimeout(ok, 0));
    assert.deepEqual(seen, [['write', 'write']]);
    assert.equal(p.children[2].getAttribute('aria-pressed'), 'true');
    assert.ok(p.children.every((b) => !b.disabled));
    p.children[2].click(); await new Promise((ok) => setTimeout(ok, 0));
    assert.equal(seen.length, 1, 'the one held: nothing to do');
    /* Refused (false, or it throws): the one held pressed again. */
    const no = KIT.RightsPicker({ key: 'secret', value: 'off', onChange: async () => false });
    assert.deepEqual(no.children.map((b) => b.dataset.value), ['none', 'use']);
    no.children[1].click(); await new Promise((ok) => setTimeout(ok, 0));
    assert.equal(no.children[0].getAttribute('aria-pressed'), 'true');
    const boom = KIT.RightsPicker({ key: 'connexion', value: 'watch', onChange: async () => { throw new Error('refused'); } });
    boom.children[4].click(); await new Promise((ok) => setTimeout(ok, 0));
    assert.equal(boom.children[1].getAttribute('aria-pressed'), 'true');
    /* A device, as it keeps them; a kind not given to that holder: nothing to choose. */
    const dev = []; const d = KIT.RightsPicker({ key: 'conversation', holder: 'device', value: 'x', onChange: (l, s) => { dev.push(s); } });
    assert.equal(d.children[1].getAttribute('aria-pressed'), 'true');
    d.children[3].click(); await new Promise((ok) => setTimeout(ok, 0));
    assert.deepEqual(dev, ['rwx']);
    assert.equal(KIT.RightsPicker({ key: 'secret', holder: 'device' }), null);
});

test('an asset\'s sign by its kind: the set\'s icon, a binder drawn here, an unknown kind a folder', () => {
    const asked = [];
    const prev = window.clavariumIcons;
    window.clavariumIcons = { icon: (name) => { asked.push(name); const s = document.createElementNS('svg', 'svg'); s.name = name; return s; } };
    try {
        for (const k of ['folder', 'git', 'mailbox', 'agenda', 'contacts', 'secret', 'acces', 'box', 'device']) assert.equal(KIT.AssetIcon({ kind: k }).dataset.kind, k);
        assert.deepEqual(asked, ['folder', 'git-branch', 'mail', 'calendar', 'user', 'key-round', 'link', 'mic', 'smartphone']);
        const list = KIT.AssetIcon({ kind: 'list' });
        assert.equal(list.children[0].tagName, 'SVG'); assert.equal(list.children[0].children.length, 5);
        assert.equal(KIT.AssetIcon({ kind: 'nonsense' }).dataset.kind, 'folder');
        assert.equal(KIT.AssetIcon({ kind: 'git' }).getAttribute('aria-hidden'), 'true');
    } finally { window.clavariumIcons = prev; }
    /* The icons the kit asks for are in the set (Parley's): none falls back to a blank page. */
    const set = readFileSync(new URL('../node_modules/clavarium-parley/ui/parley-icons.js', import.meta.url), 'utf8');
    for (const name of Object.values(KIT.ASSET_ICONS).filter(Boolean)) assert.match(set, new RegExp(`'${name}'\\s*:|\\b${name.replace(/-/g, '\\-')}\\s*:`), name);
});

test('one asset, three sizes: the same sign and name; a row says who has it or its right, a chip is small, a head its chips', () => {
    const repo = { key: 'git:website', kind: 'git', name: 'website', sub: '2 to send', state: 'wait', holders: [{ name: 'Kitchen helper' }, { name: 'Main Sales' }, { name: 'Homework' }, { name: 'Garden' }] };
    let opened = '';
    const row = KIT.AssetCard(repo, { size: 'row', current: true, onOpen: (k) => { opened = k; } });
    const chip = KIT.AssetCard(repo, { size: 'chip' });
    const head = KIT.AssetCard({ ...repo, chips: [{ text: 'Work ▾' }, { text: 'git' }] }, { size: 'head' });
    for (const [el, tag] of [[row, 'BUTTON'], [chip, 'SPAN'], [head, 'DIV']]) {
        assert.equal(el.tagName, tag);
        assert.ok(el.classes.includes('kit-asset'));
        assert.equal(el.dataset.asset, 'git:website');
        assert.equal(el.children[0].dataset.kind, 'git');
        assert.equal(el.find('kit-asset-name').textContent, 'website');
    }
    assert.equal(head.find('kit-asset-name').tagName, 'H2');
    assert.equal(row.getAttribute('aria-current'), 'true');
    row.click(); assert.equal(opened, 'git:website');
    /* Its line: the point when it asks for you, then its words. */
    assert.equal(row.find('kit-asset-sub').children[0].dataset.state, 'wait');
    assert.equal(row.find('kit-asset-sub').textContent, '2 to send');
    /* Who has it: three initials, then +1, their names in its title. A chip says none of it; a head its chips. */
    const who = row.find('kit-holders');
    assert.deepEqual(who.children.map((c) => c.textContent), ['K', 'M', 'H', '+1']);
    assert.equal(who.title, 'Kitchen helper, Main Sales, Homework, Garden');
    assert.equal(chip.find('kit-holders'), null); assert.equal(chip.find('kit-asset-sub'), null);
    assert.deepEqual(head.all((n) => n.classes.includes('kit-chip')).map((n) => n.textContent), ['Work ▾', 'git']);
    /* Nobody: said in grey. Seen from a conversation: its right in place of who has it. */
    assert.equal(KIT.AssetCard({ kind: 'folder', name: 'reports', holders: [] }).find('kit-holders-none').textContent, 'nobody');
    const given = KIT.AssetCard({ kind: 'agenda', name: 'Home calendar', live: true, right: { value: 'watch' }, holders: [{ name: 'x' }] });
    assert.equal(given.find('kit-rights').textContent, 'Watches');
    assert.equal(given.find('kit-holders'), null);
    assert.equal(KIT.AssetCard({ kind: 'secret', name: 'MODEL_KEY', right: { value: 'use' } }, { size: 'chip' }).find('kit-rights').textContent, 'Uses');
    /* Calls waiting: a count; quiet: no line, no side. */
    assert.equal(KIT.AssetCard({ key: 'demandes:all', kind: 'demandes', name: 'Requests', count: 2 }).find('kit-chip').textContent, '2');
    const quiet = KIT.AssetCard({ kind: 'folder', name: 'work' });
    assert.equal(quiet.find('kit-asset-sub'), null); assert.equal(quiet.find('kit-asset-side'), null);
    /* The place's own gestures, on its right. */
    const act = document.createElement('button');
    assert.ok(KIT.AssetCard({ kind: 'folder', name: 'work' }, { tag: 'div', actions: [act] }).find('kit-asset-side').children.includes(act));
});

test('the asset pieces\' words: English here, French in settingswords with « vous », one short line each, the same fills', async () => {
    const { SETTINGS_WORDS_FR } = await import('../server/settingswords.mjs');
    const kit = web('kit.js');
    const keys = new Set([...kit.matchAll(/say\('(set-[a-z0-9-]+)'/g)].map((m) => m[1]));
    for (const level of Object.keys(KIT.RIGHT_LEVELS)) for (const form of ['', 'pick-', 'hint-']) keys.add(`set-rt-${form}${level}`);
    for (const k of keys) {
        assert.ok(k in SETTINGS_WORDS_FR, k);
        assert.ok(SETTINGS_WORDS_FR[k].length <= 48 && !SETTINGS_WORDS_FR[k].includes('\n'), k);
        assert.doesNotMatch(SETTINGS_WORDS_FR[k], /\b(tu|ton|ta|tes)\b/i, k);
    }
    for (const [level, w] of Object.entries(KIT.RIGHT_LEVELS)) for (const form of ['badge', 'pick', 'hint']) sameFills(w[form], SETTINGS_WORDS_FR[`set-rt-${form === 'badge' ? '' : `${form}-`}${level}`]);
    /* The kit says them through the page's words when it hands them (setWords). */
    KIT.setWords((key, fallback) => SETTINGS_WORDS_FR[key] ?? fallback);
    try {
        assert.equal(KIT.RightsBadge({ level: 'read' }).textContent, 'Lit');
        assert.deepEqual(KIT.RightsPicker({ key: 'folder', value: 'none' }).children.map((b) => b.textContent), ['Aucun', 'Lire', 'Écrire']);
        assert.equal(KIT.Holders([]).textContent, 'personne');
    } finally { KIT.setWords((key, fallback) => fallback); }
});

test('the asset pieces have their style', () => {
    const css = web('style.css');
    for (const cls of ['kit-asset-ic', 'kit-asset-row', 'kit-asset-chip', 'kit-asset-head', 'kit-rights', 'kit-rights-pick', 'kit-holders', 'kit-aslist', 'kit-aslist-sec', 'kit-aslist-head', 'kit-aslist-gear']) assert.match(css, new RegExp(`\\.${cls}\\b`), cls);
    for (const tone of ['r', 'w', 'x', 'n']) assert.match(css, new RegExp(`\\.kit-rights\\[data-tone="${tone}"\\]`), tone);
});

/* THE ONE LIST (assets step 2): its model, alone. */
const KINDS = [['git', 'Git repositories'], ['folder', 'Folders'], ['mailbox', 'Mailboxes'], ['secret', 'Secrets'], ['list', 'Binders']];
const ITEMS = [
    { key: 'folder:photos', kind: 'folder', name: 'photos', holders: [{ name: 'Kitchen helper' }, { name: 'Phone' }] },
    { key: 'folder:recipes', kind: 'folder', name: 'Recipes', holders: [{ name: 'Kitchen helper' }] },
    { key: 'git:site', kind: 'git', name: 'site', holders: [{ name: 'Coder' }] },
    { key: 'secret:KEY', kind: 'secret', name: 'KEY', holders: [] },
    { key: 'connexion:files-a@example.com', kind: 'acces', name: 'a@example.com', holders: [] },
];
const GROUPS = [{ id: 'g1', label: 'Home', members: ['folder:photos', 'folder:recipes'] }, { id: 'g2', label: 'Empty', members: [] }];

test('the list by type: a type with nothing is not shown, in the page\'s order; a kind it did not name comes last, never dropped', () => {
    const m = KIT.assetListModel({ items: ITEMS, kinds: KINDS, by: 'type' });
    assert.equal(m.view, 'type');
    assert.deepEqual(m.sections.map((s) => s.title), ['Git repositories', 'Folders', 'Secrets', 'acces']);
    assert.deepEqual(m.sections.map((s) => s.items.length), [1, 2, 1, 1]);
    assert.equal(m.sections.some((s) => s.title === 'Mailboxes' || s.title === 'Binders'), false, 'no empty type');
    assert.deepEqual([m.shown, m.total], [5, 5]);
    /* Searched, any case: only the types it finds in. */
    const found = KIT.assetListModel({ items: ITEMS, kinds: KINDS, by: 'type', query: 'RECI' });
    assert.deepEqual(found.sections.map((s) => [s.title, s.items.map((i) => i.key)]), [['Folders', ['folder:recipes']]]);
    assert.equal(KIT.assetListModel({ items: ITEMS, kinds: KINDS, query: 'nothing' }).sections.length, 0);
});

test('the list\'s default view: groups once one exists, else types; a view chosen is kept; a conversation\'s by type', () => {
    assert.equal(KIT.assetListModel({ items: ITEMS, kinds: KINDS }).view, 'type', 'no group yet');
    assert.equal(KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS }).view, 'group', 'a group exists');
    assert.equal(KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS, by: 'type' }).view, 'type', 'types chosen');
    assert.equal(KIT.assetListModel({ items: ITEMS, kinds: KINDS, by: 'group' }).view, 'group', 'groups chosen, none made yet');
    const conv = KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS, by: 'group', scope: 'conversation:cuisine' });
    assert.equal(conv.view, 'type');
    assert.equal(conv.canGroup, false);
    assert.equal(KIT.assetListModel({ items: ITEMS, scope: 'all' }).canGroup, true);
});

test('the list by group: each group (an empty one kept, a place to drag to), then the loose ones; who has a group\'s assets; folded kept', () => {
    const m = KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS, folded: ['g1'] });
    assert.deepEqual(m.sections.map((s) => [s.title, s.items.length, s.drop, s.empty]), [['Home', 2, 'g1', ''], ['Empty', 0, 'g2', 'group'], ['No group', 3, '', '']]);
    assert.equal(m.sections[0].folded, true);
    assert.equal(m.sections[1].folded, false);
    assert.deepEqual(m.sections[0].holders.map((h) => h.name), ['Kitchen helper', 'Phone'], 'each once');
    /* Every asset in a group: "No group" stays, to drag one out, and says why it is empty. */
    const all = KIT.assetListModel({ items: ITEMS.slice(0, 2), groups: GROUPS, kinds: KINDS });
    assert.deepEqual(all.sections.at(-1), { id: 'group:', group: '', title: 'No group', items: [], drop: '', empty: 'grouped' });
    /* Searched: a group it finds nothing in is not shown. */
    const found = KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS, query: 'site' });
    assert.deepEqual(found.sections.map((s) => [s.title, s.items.map((i) => i.key)]), [['No group', ['git:site']]]);
    /* Nothing at all: no section. */
    assert.deepEqual(KIT.assetListModel({ items: [], groups: [], kinds: KINDS, by: 'group' }).sections, []);
});

test('the list drawn: the same AssetCard rows (who has it in Assets, its right in a conversation), pinned rows first, a group\'s head folds and opens', () => {
    const opened = []; const folded = []; const groups = [];
    const pinned = KIT.AssetCard({ key: 'demandes:all', kind: 'demandes', name: 'Demandes', sub: '2 waiting', count: 2 }, { cls: 'as-row ts-entry' });
    const list = KIT.AssetList(KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS }), { rowCls: 'as-row', chosen: 'folder:recipes', pinned: [pinned], onOpen: (k) => opened.push(k), onFold: (id) => folded.push(id), onGroup: (id) => groups.push(id) });
    assert.equal(list.dataset.view, 'group');
    assert.equal(list.children[0], pinned, 'what waits, first');
    const rows = list.all((n) => n.classes.includes('kit-asset-row') && n.dataset.asset && n !== pinned);
    assert.deepEqual(rows.map((r) => r.dataset.asset), ['folder:photos', 'folder:recipes', 'git:site', 'secret:KEY', 'connexion:files-a@example.com']);
    assert.ok(rows.every((r) => r.classes.includes('as-row')), 'the page\'s handle on each row');
    assert.equal(rows[1].getAttribute('aria-current'), 'true');
    assert.equal(rows[0].find('kit-holders').children.length, 2, 'initials, not a number');
    assert.equal(rows[3].find('kit-holders').textContent, 'nobody');
    rows[2].click();
    assert.deepEqual(opened, ['git:site']);
    const sections = list.all((n) => n.classes.includes('kit-aslist-sec'));
    assert.deepEqual(sections.map((s) => s.dataset.drop), ['g1', 'g2', '']);
    assert.match(sections[1].textContent, /drag an asset here/);
    list.find('kit-aslist-fold').click();
    list.find('kit-aslist-gear').click();
    assert.deepEqual([folded, groups], [['g1'], ['g1']]);
    assert.equal(list.find('kit-aslist-gear').getAttribute('aria-label'), 'Settings for Home');
    /* Folded: its head stays, its rows go. */
    const shut = KIT.AssetList(KIT.assetListModel({ items: ITEMS, groups: GROUPS, kinds: KINDS, folded: ['g1'] }), {});
    assert.equal(shut.all((n) => n.dataset.asset === 'folder:photos').length, 0);
    assert.equal(shut.find('kit-aslist-fold').getAttribute('aria-expanded'), 'false');
    /* A conversation's: by type, each row its right, no head to fold, no gear. */
    const mine = KIT.AssetList(KIT.assetListModel({ items: [{ key: 'folder:work', kind: 'folder', name: 'work', right: { level: 'write' } }, { key: 'secret:KEY', kind: 'secret', name: 'KEY', right: { level: 'use' } }], scope: 'conversation:cuisine', kinds: KINDS }), {});
    assert.deepEqual(mine.all((n) => n.classes.includes('kit-rights')).map((b) => b.dataset.level), ['write', 'use']);
    assert.equal(mine.find('kit-holders'), null);
    assert.equal(mine.find('kit-aslist-gear'), null);
    assert.deepEqual(mine.all((n) => n.tagName === 'H3').map((h) => h.textContent), ['Folders', 'Secrets']);
    /* Nothing at all, or nothing found: said. */
    assert.equal(KIT.AssetList(KIT.assetListModel({ items: [] }), { empty: 'Nothing is given to it yet.' }).find('kit-aslist-said').textContent, 'Nothing is given to it yet.');
    assert.equal(KIT.AssetList(KIT.assetListModel({ items: ITEMS, query: 'zzz' }), { noMatch: 'Nothing by that name.' }).find('kit-aslist-said').textContent, 'Nothing by that name.');
});

test('the screens draw the one list: Assets and a conversation\'s tab, one "+ New", the kit\'s words in the screen\'s language', () => {
    const app = web('app.js'); const html = web('index.html');
    assert.equal((app.match(/KIT\.AssetList\(/g) ?? []).length, 1, 'one place draws it');
    assert.match(app, /assetListModel\(\{[^}]*scope: 'all'/);
    assert.match(app, /assetListModel\(\{[^}]*scope: `conversation:\$\{current\}`/);
    assert.doesNotMatch(app, /function paintAsList|function paintAsGroups|'None yet'/);
    assert.match(app, /KIT\.setWords\(\(key, fallback\) => uiSaid\(key, fallback\)\)/);
    assert.match(html, /id="assets-new"/);
    assert.match(html, /id="cassets-search"/);
    assert.equal((app.match(/roundPlus\(`Add /g) ?? []).length, 0, 'no "+" per kind');
});
