import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';

function bench(t, { mounted = false, failBindfs = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-res-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vm = []; const host = [];
    const views = new Set();
    const resources = new Resources({
        store: new Store(join(dir, 'resources.json')),
        vms: new Vms(async (argv) => { vm.push(argv.join(' ')); return { code: 0, stdout: '', stderr: '' }; }, ['vmm']),
        host: async (argv) => {
            host.push(argv.join(' '));
            if (argv[0] === 'mountpoint') return { code: mounted || views.has(argv[2]) ? 0 : 1, stdout: '', stderr: '' };
            if (argv[0] === 'bindfs') { if (failBindfs) return { code: 1, stdout: '', stderr: 'fuse: device not found' }; views.add(argv.at(-1)); }
            return { code: 0, stdout: '', stderr: '' };
        },
        dataDir: dir, uid: 1001, gid: 1002,
    });
    return { dir, vm, host, resources };
}

test('a READ attachment mounts the read-only view, never the folder itself', async (t) => {
    const b = bench(t);
    b.resources.create({ name: 'notes' });
    assert.ok(existsSync(join(b.dir, 'resources', 'notes')));
    await b.resources.attach('alpha', 'notes', 'read');
    assert.deepEqual(b.host, [`mountpoint -q ${b.dir}/views/notes`, `bindfs -r -o allow_other ${b.dir}/resources/notes ${b.dir}/views/notes`]);
    assert.deepEqual(b.vm, [`mount -u 1001:1000 -g 1002:1000 ${b.dir}/views/notes clv-alpha:/resources/notes`]);
    assert.deepEqual(b.resources.of('alpha'), [{ name: 'notes', access: 'read' }]);
});

test('a WRITE attachment mounts the folder; the same folder can be read by another conversation', async (t) => {
    const b = bench(t);
    b.resources.create({ name: 'reports' });
    await b.resources.attach('alpha', 'reports', 'write');
    await b.resources.attach('beta', 'reports', 'read');
    assert.deepEqual(b.vm, [
        `mount -u 1001:1000 -g 1002:1000 ${b.dir}/resources/reports clv-alpha:/resources/reports`,
        `mount -u 1001:1000 -g 1002:1000 ${b.dir}/views/reports clv-beta:/resources/reports`,
    ]);
    assert.deepEqual(b.resources.list()[0].attachments, { alpha: 'write', beta: 'read' });
});

test('changing the level detaches first; "none" detaches; asking twice does nothing', async (t) => {
    const b = bench(t);
    b.resources.create({ name: 'notes' });
    await b.resources.attach('alpha', 'notes', 'write');
    await b.resources.attach('alpha', 'notes', 'write');
    await b.resources.attach('alpha', 'notes', 'read');
    await b.resources.attach('alpha', 'notes', 'none');
    await b.resources.attach('alpha', 'notes', 'none');
    assert.deepEqual(b.vm.map((c) => c.split(' ')[0]), ['mount', 'umount', 'mount', 'umount']);
    assert.deepEqual(b.resources.of('alpha'), []);
});

test('no view, no read attachment: nothing is mounted when the view cannot be made', async (t) => {
    const b = bench(t, { failBindfs: true });
    b.resources.create({ name: 'notes' });
    await assert.rejects(b.resources.attach('alpha', 'notes', 'read'), /read-only view could not be made/);
    assert.deepEqual(b.vm, []);
    assert.deepEqual(b.resources.of('alpha'), []);
});

test('after a restart, the views of read attachments are put back, and only those', async (t) => {
    const b = bench(t);
    b.resources.create({ name: 'notes' }); b.resources.create({ name: 'reports' });
    await b.resources.attach('alpha', 'notes', 'read');
    await b.resources.attach('alpha', 'reports', 'write');
    b.host.length = 0;
    await b.resources.ensureViews();
    assert.deepEqual(b.host, [`mountpoint -q ${b.dir}/views/notes`]);
});

test('bad names, unknown resources and unknown levels are refused; archiving forgets the attachments', async (t) => {
    const b = bench(t);
    assert.throws(() => b.resources.create({ name: '../etc' }), /name/);
    b.resources.create({ name: 'notes' });
    assert.throws(() => b.resources.create({ name: 'notes' }), /already/);
    await assert.rejects(b.resources.attach('alpha', 'nope', 'read'), /No such resource/);
    await assert.rejects(b.resources.attach('alpha', 'notes', 'admin'), /Access is/);
    await assert.rejects(b.resources.attach('Bad Name', 'notes', 'read'), /Not a conversation/);
    await b.resources.attach('alpha', 'notes', 'write');
    b.resources.forget('alpha');
    assert.deepEqual(b.resources.of('alpha'), []);
});
