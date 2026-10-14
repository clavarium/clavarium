import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, renameSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { Grants } from '../server/grants.mjs';

function bench(t, { failView = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-res-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vm = []; const host = [];
    const resources = new Resources({
        store: new Store(join(dir, 'resources.json')),
        vms: new Vms(async (argv) => { vm.push(argv.slice(1).join(' ')); return { code: 0, stdout: '', stderr: '' }; }, ['vmm']),
        host: async (argv) => {
            host.push(argv.join(' '));
            if (failView && argv.join(' ').startsWith('view make')) return { code: 1, stdout: '', stderr: 'fuse: device not found' };
            /* What the host program does for a folder, without the root part. */
            if (argv[0] === 'folder' && argv[1] === 'make') mkdirSync(join(dir, 'resources', argv[2]), { recursive: true });
            if (argv[0] === 'folder' && argv[1] === 'aside') { mkdirSync(join(dir, 'removed'), { recursive: true }); renameSync(join(dir, 'resources', argv[2]), join(dir, 'removed', `${argv[2]}-then`)); }
            return { code: 0, stdout: '', stderr: '' };
        },
        dataDir: dir, uid: 1001, gid: 1002,
    });
    return { dir, vm, host, resources };
}

test('a READ attachment mounts the read-only view, never the folder itself', async (t) => {
    const b = bench(t);
    await b.resources.create({ name: 'notes' });
    assert.ok(existsSync(join(b.dir, 'resources', 'notes')));
    await b.resources.attach('alpha', 'notes', 'read');
    assert.deepEqual(b.host, ['folder make notes', 'view make notes']);
    /* A name, never a path: the host program decides which directory that is. */
    assert.deepEqual(b.vm, ['mount clv-alpha view notes 1001 1002']);
    assert.deepEqual(b.resources.of('alpha'), [{ name: 'notes', access: 'read' }]);
});

test('a WRITE attachment mounts the folder; the same folder can be read by another conversation', async (t) => {
    const b = bench(t);
    await b.resources.create({ name: 'reports' });
    await b.resources.attach('alpha', 'reports', 'write');
    await b.resources.attach('beta', 'reports', 'read');
    assert.deepEqual(b.vm, [
        'mount clv-alpha folder reports 1001 1002',
        'mount clv-beta view reports 1001 1002',
    ]);
    assert.deepEqual(b.resources.list()[0].attachments, { alpha: 'write', beta: 'read' });
});

test('changing the level detaches first; "none" detaches; asking twice does nothing', async (t) => {
    const b = bench(t);
    await b.resources.create({ name: 'notes' });
    await b.resources.attach('alpha', 'notes', 'write');
    await b.resources.attach('alpha', 'notes', 'write');
    await b.resources.attach('alpha', 'notes', 'read');
    await b.resources.attach('alpha', 'notes', 'none');
    await b.resources.attach('alpha', 'notes', 'none');
    assert.deepEqual(b.vm.map((c) => c.split(' ')[0]), ['mount', 'umount', 'mount', 'umount']);
    assert.deepEqual(b.resources.of('alpha'), []);
});

test('no view, no read attachment: nothing is mounted when the view cannot be made', async (t) => {
    const b = bench(t, { failView: true });
    await b.resources.create({ name: 'notes' });
    await assert.rejects(b.resources.attach('alpha', 'notes', 'read'), /read-only view could not be made/);
    assert.deepEqual(b.vm, []);
    assert.deepEqual(b.resources.of('alpha'), []);
});

test('after a restart, the views of read attachments are put back, and only those', async (t) => {
    const b = bench(t);
    await b.resources.create({ name: 'notes' }); await b.resources.create({ name: 'reports' });
    await b.resources.attach('alpha', 'notes', 'read');
    await b.resources.attach('alpha', 'reports', 'write');
    b.host.length = 0;
    await b.resources.ensureViews();
    assert.deepEqual(b.host, ['view make notes']);
});

test('bad names, unknown resources and unknown levels are refused; archiving forgets the attachments', async (t) => {
    const b = bench(t);
    await assert.rejects(b.resources.create({ name: '../etc' }), /name/);
    await b.resources.create({ name: 'notes' });
    await assert.rejects(b.resources.create({ name: 'notes' }), /already/);
    await assert.rejects(b.resources.create({ name: 'work' }), /where each conversation works/);
    assert.equal(b.resources.workFolder('alpha'), `${b.dir}/work/alpha`);
    assert.throws(() => b.resources.workFolder('../x'), /Not a conversation/);
    await assert.rejects(b.resources.attach('alpha', 'nope', 'read'), /No such resource/);
    await assert.rejects(b.resources.attach('alpha', 'notes', 'admin'), /Access is/);
    await assert.rejects(b.resources.attach('Bad Name', 'notes', 'read'), /Not a conversation/);
    await b.resources.attach('alpha', 'notes', 'write');
    b.resources.forget('alpha');
    assert.deepEqual(b.resources.of('alpha'), []);
});

test('a folder is removed only when attached nowhere, and its files are moved aside, not erased', async (t) => {
    const b = bench(t);
    await b.resources.create({ name: 'notes' });
    writeFileSync(join(b.dir, 'resources', 'notes', 'keep.txt'), 'precious');
    await b.resources.attach('alpha', 'notes', 'read');
    await assert.rejects(b.resources.remove('notes'), /still attached to: alpha/);
    await b.resources.attach('alpha', 'notes', 'none');
    b.host.length = 0;
    await b.resources.remove('notes');
    assert.deepEqual(b.host, ['view close notes', 'folder aside notes'], 'its read-only view is closed first');
    assert.deepEqual(b.resources.list(), []);
    assert.equal(existsSync(join(b.dir, 'resources', 'notes')), false);
    const aside = readdirSync(join(b.dir, 'removed'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(b.dir, 'removed', aside[0], 'keep.txt'), 'utf8'), 'precious');
    await assert.rejects(b.resources.remove('notes'), /No such folder/);
});

test('a mount the VM manager already holds is replaced, not reported as a failure', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-res-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = []; let first = true;
    const vms = new Vms(async (argv) => {
        calls.push(argv[1]);
        if (argv[1] === 'mount' && first) { first = false; return { code: 2, stdout: '', stderr: 'mount failed: "/resources/notes" is already mounted in \'clv-alpha\'' }; }
        return { code: 0, stdout: '', stderr: '' };
    }, ['vmm']);
    const resources = new Resources({ store: new Store(join(dir, 'resources.json')), vms, host: async () => ({ code: 0, stdout: '', stderr: '' }), dataDir: dir, uid: 1, gid: 1 });
    await resources.create({ name: 'notes' });
    await resources.attach('alpha', 'notes', 'write');
    assert.deepEqual(calls, ['mount', 'umount', 'mount']);
    assert.deepEqual(resources.of('alpha'), [{ name: 'notes', access: 'write' }]);
});

test('a machine built again gets its folders back: the view for reading, the folder for writing', async (t) => {
    const b = bench(t);
    await b.resources.create({ name: 'notes' }); await b.resources.create({ name: 'reports' });
    await b.resources.attach('alpha', 'notes', 'read');
    await b.resources.attach('alpha', 'reports', 'write');
    b.vm.length = 0; b.host.length = 0;
    assert.deepEqual(await b.resources.remount('alpha'), []);
    assert.deepEqual(b.vm, ['mount clv-alpha view notes 1001 1002', 'mount clv-alpha folder reports 1001 1002']);
    assert.deepEqual(b.host, ['view make notes']);
    assert.deepEqual(await b.resources.remount('nobody'), []);
});

test('attachments kept by an earlier version are taken over into the table of rights', async (t) => {
    const b = bench(t);
    const store = new Store(join(b.dir, 'old.json'));
    store.put({ name: 'reports', type: 'folder', attachments: { alpha: 'write', beta: 'read' }, createdAt: 'x' });
    const grants = new Grants();
    const upgraded = new Resources({ store, vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['x']), host: async () => ({ code: 0, stdout: '', stderr: '' }), dataDir: b.dir, grants });
    assert.deepEqual(upgraded.of('alpha'), [{ name: 'reports', access: 'write' }]);
    assert.deepEqual(upgraded.of('beta'), [{ name: 'reports', access: 'read' }]);
    assert.equal(grants.rightsOf('conversation:alpha', 'folder:reports'), 'rw');
    assert.deepEqual(upgraded.list()[0].attachments, { alpha: 'write', beta: 'read' });
    assert.equal(store.get('reports').attachments, undefined);
});

test('a git repository is a folder that starts as one: made empty or cloned, by git run once, with hooks off', async (t) => {
    const b = bench(t);
    const ran = [];
    const grants = new Grants();
    const make = (fail) => new Resources({ store: new Store(join(b.dir, 'git.json')), vms: new Vms(async (argv) => { b.vm.push(argv.slice(1).join(' ')); return { code: 0, stdout: '', stderr: '' }; }, ['x']),
        host: async (argv) => { b.host.push(argv.join(' ')); if (argv[0] === 'folder' && argv[1] === 'make') mkdirSync(join(b.dir, 'resources', argv[2]), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; },
        dataDir: b.dir, uid: 1, gid: 1, grants, git: async (argv, cwd) => { ran.push({ argv: argv.join(' '), cwd }); return fail ? { code: 128, stderr: 'fatal: repository not found' } : { code: 0, stderr: '' }; } });
    const resources = make(false);
    const empty = await resources.create({ name: 'site', type: 'git' });
    assert.equal(empty.type, 'git');
    assert.deepEqual(ran[0], { argv: '-c core.hooksPath=/dev/null -c protocol.file.allow=never init --quiet --initial-branch=main', cwd: join(b.dir, 'resources', 'site') });
    const cloned = await resources.create({ name: 'docs', type: 'git', from: 'https://example.com/team/docs.git' });
    assert.equal(cloned.from, 'https://example.com/team/docs.git');
    assert.match(ran[1].argv, /clone --quiet --no-recurse-submodules -- https:\/\/example\.com\/team\/docs\.git \.$/);
    assert.equal(resources.assetOf(cloned), 'git:docs');
    /* Attached like a folder: the view to read, the folder to write. */
    await resources.attach('alpha', 'docs', 'read');
    assert.equal(grants.rightsOf('conversation:alpha', 'git:docs'), 'r');
    /* Where it may come from: https, and nothing a command line could take for an option.
       (ssh needs a way in, which a server without private repositories has not: see gitaccess.test.) */
    for (const from of ['http://example.com/x.git', 'ssh://git@example.com/x.git', 'git@example.com:x.git', 'https://user:pw@example.com/x.git', '--upload-pack=id', 'file:///etc', 'https://example.com/x y.git']) {
        await assert.rejects(resources.create({ name: 'bad', type: 'git', from }), /repository address is https|public https address/, from);
    }
    await assert.rejects(resources.create({ name: 'bad', type: 'git', from: 'https://example.com/x.git', via: { method: 'token', secret: 'x' } }), /public https address/);
    assert.equal(ran.length, 2, 'git was not run for any of those');
    /* A clone that fails leaves no folder on the list; what was made is put aside. */
    const failing = make(true);
    await assert.rejects(failing.create({ name: 'ghost', type: 'git', from: 'https://example.com/none.git' }), /could not be cloned: fatal: repository not found/);
    assert.equal(failing.list().some((r) => r.name === 'ghost'), false);
    assert.equal(b.host.at(-1), 'folder aside ghost');
    await assert.rejects(resources.create({ name: 'odd', type: 'shadow' }), /folder, a mailbox or a git repository/);
});

test('the folders, their views and the work folders are where the host program keeps them: under MNT, not in the data directory', (t) => {
    /* The host program mounts them from $MNT, a chain root owns; the server
       must look for them there too (the page's Files, the talk folder). */
    const dir = mkdtempSync(join(tmpdir(), 'clv-res-mnt-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const data = join(dir, 'data'); const mnt = join(dir, 'mnt');
    const resources = new Resources({ store: new Store(join(data, 'resources.json')), vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']), host: async () => ({ code: 0, stdout: '', stderr: '' }), dataDir: data, mntDir: mnt, uid: 1001, gid: 1002 });
    assert.equal(resources.folder('notes'), join(mnt, 'resources', 'notes'));
    assert.equal(resources.view('notes'), join(mnt, 'views', 'notes'));
    assert.equal(resources.workFolder('alpha'), join(mnt, 'work', 'alpha'));
});
