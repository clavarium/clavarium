import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, Refusal } from '../server/conversations.mjs';
import { Store, JsonFile } from '../server/store.mjs';
import { Instance } from '../server/instance.mjs';
import { groupProblem, appNameFrom, shortAppName, appNameProblem } from '../server/names.mjs';
import { readTools } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([{ id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [] }]));

function bench(t, names = ['a', 'b', 'c', 'd']) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-folders-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(join(dir, 'conversations.json'));
    for (const name of names) store.put({ name, tool: 'tool', phase: 'ready', memoryMb: 1024 });
    const make = () => new Conversations({ store, layout: new JsonFile(join(dir, 'layout.json'), {}), vms: { state: async () => 'Running', exec: async () => ({ code: 0 }) }, tools: TOOLS });
    return { dir, store, make };
}
const order = (all) => all.list().map((c) => c.name);

test('a folder is a word on its conversations, checked like a name; one folder level, and an empty one is gone', (t) => {
    const { make } = bench(t);
    const all = make();
    for (const good of ['', 'Clients', 'Été 2026', 'Q3 – 🚗']) assert.equal(groupProblem(good), '', good);
    for (const bad of [' lead', 'two\nlines', `a${String.fromCodePoint(0x202e)}b`, 'x'.repeat(41), 3]) assert.notEqual(groupProblem(bad), '', JSON.stringify(bad));
    assert.throws(() => all.setGroup('a', 'bad\nname'), (e) => e instanceof Refusal && e.status === 400);
    assert.throws(() => all.setGroup('nope', 'X'), (e) => e.status === 404);
    all.setGroup('c', 'Work');
    assert.equal(all.list().find((c) => c.name === 'c').group, 'Work');
    assert.equal(order(all)[0], 'c', 'first in its folder');
    all.setGroup('c', '');
    assert.equal(all.list().find((c) => c.name === 'c').group, undefined, 'out of every folder');
    assert.equal(all.list().some((c) => c.groupRank !== undefined), false, 'no conversation left in it: no folder');
});

test('a folder renamed is renamed for all its conversations; to the name of another, they join it', (t) => {
    const { make } = bench(t);
    const all = make();
    all.setGroup('a', 'One'); all.setGroup('b', 'One'); all.setGroup('c', 'Two');
    assert.deepEqual(all.renameGroup('One', 'Uno'), { renamed: 2, group: 'Uno' });
    assert.deepEqual(all.list().filter((c) => c.group === 'Uno').map((c) => c.name).sort(), ['a', 'b']);
    assert.throws(() => all.renameGroup('One', 'X'), (e) => e.status === 404);
    assert.throws(() => all.renameGroup('Uno', ''), (e) => e.status === 400);
    assert.throws(() => all.renameGroup('Uno', ' x'), (e) => e.status === 400);
    all.renameGroup('Two', 'Uno');
    assert.equal(all.list().filter((c) => c.group === 'Uno').length, 3);
    assert.equal(new Set(all.list().filter((c) => c.group).map((c) => c.groupRank)).size, 1, 'one folder left');
});

test('the order is kept by the server, the same for every page, and survives a restart', (t) => {
    const { make, dir } = bench(t);
    let all = make();
    assert.deepEqual(order(all), ['a', 'b', 'c', 'd'], 'made before: in the order they were made');
    all.move('c', 'up');
    assert.deepEqual(order(all), ['a', 'c', 'b', 'd']);
    all.move('a', 'up');
    assert.deepEqual(order(all), ['a', 'c', 'b', 'd'], 'the first stays first');
    assert.throws(() => all.move('a', 'sideways'), (e) => e.status === 400);
    all.setGroup('b', 'F'); all.setGroup('d', 'F');
    /* In its folder, it passes over the others of the folder only. */
    all.move('b', 'down');
    const inF = order(all).filter((n) => ['b', 'd'].includes(n));
    assert.deepEqual(inF, ['b', 'd'].includes(inF[0]) ? inF : [], 'moved within F');
    all.setGroup('a', 'G');
    all.moveGroup('G', 'up');
    assert.equal(all.list().find((c) => c.group === 'G').groupRank, 0);
    assert.throws(() => all.moveGroup('None', 'up'), (e) => e.status === 404);
    /* A whole order, as a drag and drop leaves it: unknown names left out, forgotten ones after. */
    all.setOrder({ order: ['d', 'ghost', 'c'], groups: ['F'] });
    assert.deepEqual(order(all).slice(0, 2), ['d', 'c']);
    assert.equal(all.list().find((c) => c.group === 'F').groupRank, 0);
    assert.throws(() => all.setOrder({ order: 'abc' }), (e) => e.status === 400);
    assert.throws(() => all.setOrder({ order: [1] }), (e) => e.status === 400);
    const before = order(all);
    all = make();
    assert.deepEqual(order(all), before, 'read again from its file');
    assert.ok(JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')).order.length >= 4);
});

test('a hidden conversation is passed over by one that is shown', (t) => {
    const { make, store } = bench(t, ['a', 'b', 'c']);
    store.patch('b', { hidden: true });
    const all = make();
    all.move('c', 'up');
    assert.deepEqual(order(all), ['c', 'b', 'a']);
});

test('a new conversation comes first, in the folder it was made in', async (t) => {
    const { make } = bench(t);
    const all = make();
    assert.throws(() => all.create({ title: 'Bad', tool: 'tool', group: 'x\ny' }), (e) => e.status === 400);
    all.create({ title: 'Fresh one', tool: 'tool', group: 'Clients' });
    await all.built?.catch(() => {});
    const fresh = all.list().find((c) => c.name === 'fresh-one');
    assert.equal(fresh.group, 'Clients');
    assert.equal(order(all)[0], 'fresh-one');
});

test('the name of this Clavarium: drawn from its address, given at the install, chosen in Settings; its manifest carries it', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-instance-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(appNameFrom('https://clav.example.com'), 'Clav');
    assert.equal(appNameFrom(undefined), 'Clavarium');
    assert.equal(appNameFrom('http://localhost:7717'), 'Clavarium');
    assert.equal(shortAppName('Home'), 'Home');
    assert.equal(shortAppName('Family workshop server'), 'Family');
    assert.equal(shortAppName('Supercalifragilistic'), 'Supercalifra');
    assert.notEqual(appNameProblem('x'.repeat(31)), '');
    const file = new JsonFile(join(dir, 'instance.json'), {});
    let instance = new Instance({ file, origin: 'https://atelier.example.com' });
    assert.deepEqual(instance.about(), { name: 'Atelier', defaultName: 'Atelier', given: false });
    assert.equal(new Instance({ origin: 'https://atelier.example.com', given: 'Home lab' }).name(), 'Home lab', '--name at the install');
    assert.equal(instance.setName('Maison "<b>"').name, 'Maison "<b>"');
    assert.throws(() => instance.setName('two\nlines'), (e) => e.status === 400);
    assert.throws(() => instance.setName(5), (e) => e.status === 400);
    instance = new Instance({ file: new JsonFile(join(dir, 'instance.json'), {}), origin: 'https://atelier.example.com' });
    assert.equal(instance.name(), 'Maison "<b>"', 'kept');
    const manifest = JSON.parse(instance.manifest());
    assert.equal(manifest.name, 'Maison "<b>"');
    assert.equal(manifest.short_name, 'Maison "<b>"', 'twelve characters: it fits');
    assert.equal(manifest.start_url, './');
    assert.equal(JSON.parse(instance.manifest('Kitchen')).name, 'Kitchen', 'the name one device chose');
    assert.equal(JSON.parse(instance.manifest('bad‮name')).name, 'Maison "<b>"', 'not a name: the usual one');
    assert.equal(instance.setName('').name, 'Atelier', 'nothing: back to the address');
});
