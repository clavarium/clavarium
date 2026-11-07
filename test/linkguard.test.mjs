/* Links a shared folder cannot serve (linkguard.mjs): found on the server,
   removed where safe (a node_modules link, a loop, a link to nowhere
   outside), said once; anything else said and left; bounded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFolder, removeLink, removable, LinkGuard, removedLine, toolLine, CAPS } from '../server/linkguard.mjs';
import { Health, judge } from '../server/health.mjs';

const place = () => realpathSync(mkdtempSync(join(tmpdir(), 'clv-links-')));
const kinds = (r) => Object.fromEntries(r.links.map((l) => [l.path, l.kind]));

test('escaping, absolute, dangling and looping links are found; links inside the folder are not', async () => {
    const top = place(); const root = join(top, 'shared'); const elsewhere = join(top, 'elsewhere');
    mkdirSync(join(root, 'app', 'src'), { recursive: true }); mkdirSync(elsewhere);
    writeFileSync(join(root, 'app', 'src', 'a.js'), 'x');
    symlinkSync('src/a.js', join(root, 'app', 'good'));
    symlinkSync('../elsewhere', join(root, 'out'));
    symlinkSync(join(root, 'app', 'src'), join(root, 'abs'));
    symlinkSync('missing.txt', join(root, 'app', 'later'));
    symlinkSync('/no/such/place', join(root, 'nowhere'));
    symlinkSync('self', join(root, 'self'));
    const r = await scanFolder(root);
    assert.deepEqual(kinds(r), { out: 'outside', abs: 'absolute', 'app/later': 'dangling', nowhere: 'dangling', self: 'loop' });
    assert.equal(r.cut, null);
    const by = Object.fromEntries(r.links.map((l) => [l.path, l]));
    assert.equal(removable(by.self), true, 'a loop points nowhere');
    assert.equal(removable(by.nowhere), true, 'nowhere outside the folder');
    assert.equal(removable(by['app/later']), false, 'a target inside, not made yet: said, left');
    assert.equal(removable(by.out), false); assert.equal(removable(by.abs), false);
    rmSync(top, { recursive: true, force: true });
});

test('a node_modules link is removed, its target untouched; a normal folder untouched; said once', async () => {
    const top = place(); const root = join(top, 'collect-factory'); const deps = join(top, 'worktree-deps');
    mkdirSync(join(root, 'app'), { recursive: true }); mkdirSync(join(root, 'lib', 'node_modules', 'pkg'), { recursive: true }); mkdirSync(join(deps, 'left-pad'), { recursive: true });
    writeFileSync(join(deps, 'left-pad', 'index.js'), 'module.exports = 1');
    writeFileSync(join(root, 'lib', 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(root, 'app', 'package.json'), '{}');
    symlinkSync(deps, join(root, 'app', 'node_modules'));
    symlinkSync('/srv/elsewhere/gone', join(root, 'notes'));
    const said = [];
    const resources = { of: () => [{ name: 'collect-factory' }], folder: () => root, attachedTo: () => ['hvergelmir', 'other'], get: () => ({ type: 'git' }) };
    const guard = new LinkGuard({ resources });
    guard.removed = (conversation, link) => said.push([conversation, removedLine(link)]);
    const first = await guard.check('hvergelmir');
    assert.deepEqual(first.removed.map((l) => [l.folder, l.path]).sort(), [['collect-factory', 'app/node_modules'], ['collect-factory', 'notes']]);
    assert.equal(existsSync(join(root, 'app', 'node_modules')), false, 'the link is gone');
    assert.equal(lstatSync(deps).isDirectory(), true, 'its target is untouched');
    assert.deepEqual(readdirSync(join(deps, 'left-pad')), ['index.js']);
    assert.equal(existsSync(join(root, 'lib', 'node_modules', 'pkg', 'index.js')), true, 'a real node_modules is left alone');
    assert.equal(existsSync(join(root, 'app', 'package.json')), true);
    assert.deepEqual(first.found, []);
    /* A link to nowhere outside the folder: removed too, and said. */
    assert.equal(existsSync(join(root, 'notes')), false);
    assert.deepEqual(said.sort(), [
        ['hvergelmir', 'Un lien node_modules cassé dans collect-factory (app/node_modules) a été retiré ; ses dépendances sont à réinstaller.'],
        ['hvergelmir', 'Un lien cassé dans collect-factory (notes) a été retiré : il ne menait nulle part.'],
        ['other', 'Un lien node_modules cassé dans collect-factory (app/node_modules) a été retiré ; ses dépendances sont à réinstaller.'],
        ['other', 'Un lien cassé dans collect-factory (notes) a été retiré : il ne menait nulle part.'],
    ].sort(), 'each conversation the folder is attached to, once');
    /* The same link back (its worktree again): removed again, said no more the same day. */
    symlinkSync(deps, join(root, 'app', 'node_modules'));
    const again = await guard.check('hvergelmir', { force: true });
    assert.equal(again.removed.length, 1);
    assert.equal(said.length, 4, 'said once');
    assert.match(toolLine({ folder: 'collect-factory', path: 'app/node_modules' }), /npm ci \(or npm install\) in \/resources\/collect-factory\/app\. If your rules forbid npm install, ask the operator to allow it\./);
    rmSync(top, { recursive: true, force: true });
});

test('a folder with nothing wrong is left exactly as it was, and looked at again only when due or asked', async () => {
    const root = place();
    mkdirSync(join(root, 'a', 'b'), { recursive: true }); writeFileSync(join(root, 'a', 'b', 'f'), 'x'); symlinkSync('b/f', join(root, 'a', 'l'));
    let clock = 0; let scans = 0;
    const resources = { of: () => [{ name: 'r' }], folder: () => { scans += 1; return root; }, attachedTo: () => ['c'] };
    const guard = new LinkGuard({ resources, now: () => clock, everyMs: 1000 });
    assert.deepEqual(await guard.check('c'), { found: [], removed: [], cut: [] });
    await guard.check('c'); assert.equal(scans, 1, 'not again before it is due');
    await guard.check('c', { force: true }); assert.equal(scans, 2, 'again when asked');
    clock = 5000; await guard.check('c'); assert.equal(scans, 3, 'again once due');
    assert.deepEqual(readdirSync(join(root, 'a')).sort(), ['b', 'l']);
    rmSync(root, { recursive: true, force: true });
});

test('the look is bounded: depth, entries, time, links; .git is not walked', async () => {
    const root = place();
    mkdirSync(join(root, '1', '2', '3', '4'), { recursive: true });
    symlinkSync('/deep/down', join(root, '1', '2', '3', '4', 'x'));
    mkdirSync(join(root, '.git')); symlinkSync('/in/git', join(root, '.git', 'y'));
    for (let i = 0; i < 30; i += 1) writeFileSync(join(root, `f${i}`), '');
    for (let i = 0; i < 5; i += 1) symlinkSync(`/abs/${i}`, join(root, `l${i}`));
    const deep = await scanFolder(root, { ...CAPS, depth: 2 });
    assert.equal(deep.cut, 'depth');
    assert.ok(!deep.links.some((l) => l.path.startsWith('1/')), 'not deeper than asked');
    assert.ok(!deep.links.some((l) => l.path.startsWith('.git/')));
    assert.equal((await scanFolder(root, { ...CAPS, entries: 10 })).cut, 'entries');
    assert.equal((await scanFolder(root, { ...CAPS, links: 2 })).links.length, 2);
    let t = 0;
    assert.equal((await scanFolder(root, { ...CAPS, ms: 5 }, () => (t += 1))).cut, 'time');
    assert.equal((await scanFolder(root)).links.some((l) => l.path === '1/2/3/4/x'), true, 'within the default caps');
    rmSync(root, { recursive: true, force: true });
});

test('only a link is ever removed, and only inside its folder', async () => {
    const root = place();
    mkdirSync(join(root, 'd')); writeFileSync(join(root, 'f'), 'x');
    assert.equal(await removeLink(root, 'f'), 'not a link any more');
    assert.equal(await removeLink(root, 'd'), 'not a link any more');
    assert.equal(await removeLink(root, '../outside'), 'not in the folder');
    assert.equal(await removeLink(root, 'gone'), 'already gone');
    assert.equal(existsSync(join(root, 'f')) && existsSync(join(root, 'd')), true);
    rmSync(root, { recursive: true, force: true });
});

test('health: what the guard found and removed is said; a link-only problem is one of its own', () => {
    const j = judge({ state: 'Running', answering: true, links: { removed: [{ folder: 'cf', path: 'app/node_modules', kind: 'dangling' }], found: [{ folder: 'cf', path: 'abs', kind: 'absolute' }], cut: [] } });
    assert.deepEqual(j.problems.map((p) => [p.level, p.kind, p.key]), [['info', 'link', 'link-removed:cf/app/node_modules'], ['warn', 'link', 'link:cf/abs']]);
    assert.match(j.problems[1].text, /\/resources\/cf\/abs is a link its machine cannot follow \(its target is an absolute path of the server\)/);
});

test('"Check shared folders": each mount and each link, one item each; asked, the links are looked at now', async () => {
    let forced = null;
    const links = { check: async (name, { force }) => { forced = force; return { found: [{ folder: 'cf', path: 'abs', kind: 'absolute' }], removed: [{ folder: 'cf', path: 'app/node_modules', kind: 'dangling' }], cut: [] }; } };
    const vms = { state: async () => 'Running', exec: async () => ({ code: 0, stdout: 'memory 2048000 1024000\noom 0\ndisk / 4000 8000\nmount ok /work\nmount ok /resources/cf\n' }) };
    const conversations = { get: () => ({ phase: 'ready', work: 'kept' }), awake: () => [] };
    const resources = { expected: () => ['/work', '/resources/cf'] };
    const health = new Health({ vms, conversations, resources, links, settleMs: 0 });
    const r = await health.checkFolders('hvergelmir');
    assert.equal(forced, true);
    assert.deepEqual(r.items, [
        { kind: 'mount-ok', path: '/work' }, { kind: 'mount-ok', path: '/resources/cf' },
        { kind: 'link-removed', folder: 'cf', path: 'app/node_modules', why: 'dangling' },
        { kind: 'link-found', folder: 'cf', path: 'abs', why: 'absolute' },
    ]);
    /* Asleep: not woken; its folders' links are still looked at. */
    const asleep = new Health({ vms: { ...vms, state: async () => 'Suspended' }, conversations, resources, links, settleMs: 0 });
    const s = await asleep.checkFolders('hvergelmir');
    assert.deepEqual(s.items.map((x) => x.kind), ['machine-off', 'link-removed', 'link-found']);
});
