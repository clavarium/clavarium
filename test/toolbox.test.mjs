/* The tools at hand: a folder every machine sees at /tools, read-only, with
   an index; Parley's archive is the first thing in it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Toolbox, parleySource, TOOLS_PATH } from '../server/toolbox.mjs';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';

function bench(t, { make = 0, mount = { code: 0 } } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tools-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked = [];
    const host = async (argv) => { asked.push(argv.join(' ')); return { code: make, stderr: make ? 'REFUSED: the tools folder is not what it should be' : '' }; };
    const vms = {
        mountTools: async (name, uid, gid) => { asked.push(`mount ${name} ${uid} ${gid}`); return typeof mount === 'function' ? mount() : mount; },
        unmountTools: async (name) => { asked.push(`unmount ${name}`); return { code: 0 }; },
    };
    const box = new Toolbox({ host, vms, mntDir: dir, uid: 994, gid: 985 });
    return { dir, asked, box, vms, host };
}

test('Parley is the first tool: its archive as npm packed it, with one line of usage', () => {
    const [parley] = parleySource();
    assert.equal(parley.name, 'parley');
    assert.match(parley.archive, /server\/parley\/clavarium-parley-\d+\.\d+\.\d+\.tgz$/);
    assert.equal(readFileSync(parley.archive).subarray(0, 2).toString('hex'), '1f8b', 'a gzip archive');
    /* Installed by the server: nothing in the index asks a tool to install it. */
    assert.equal(parley.usage('/tools/x.tgz'), 'Installed in every machine: parley --help. Talk with the person you work for, on their screen, when their chat is on.');
});

test('the folder is made by the host program, then filled: each archive, and an index of name, version, checksum and usage', async (t) => {
    const b = bench(t);
    assert.equal(b.box.ready, false);
    assert.equal(b.box.find('parley'), undefined, 'nothing to offer before it is in place');
    const index = await b.box.prepare();
    assert.deepEqual(b.asked, ['tools make']);
    const files = join(b.dir, 'toolbox', 'files');
    const [archive] = readdirSync(files).filter((f) => f.endsWith('.tgz'));
    const sha256 = createHash('sha256').update(readFileSync(join(files, archive))).digest('hex');
    assert.equal(sha256, createHash('sha256').update(readFileSync(parleySource()[0].archive)).digest('hex'));
    assert.deepEqual(index, { tools: [{ name: 'parley', version: /-(\d+\.\d+\.\d+)\.tgz$/.exec(archive)[1], file: archive, sha256, usage: 'Installed in every machine: parley --help. Talk with the person you work for, on their screen, when their chat is on.' }] });
    assert.deepEqual(JSON.parse(readFileSync(join(files, 'index.json'), 'utf8')), index, 'what a tool reads in /tools/index.json');
    assert.equal(b.box.find('parley').path, `${TOOLS_PATH}/${archive}`);
    /* Prepared again: what is no longer listed goes, what is there is kept. */
    writeFileSync(join(files, 'clavarium-parley-0.0.1.tgz'), 'an old one');
    mkdirSync(join(files, 'stray'));
    await b.box.prepare();
    assert.deepEqual(readdirSync(files).sort(), [archive, 'index.json'].sort());
    /* The host program refuses: said, and nothing is offered. */
    const refused = bench(t, { make: 78 });
    await assert.rejects(refused.box.prepare(), /could not be made: REFUSED: the tools folder is not what it should be/);
    assert.equal(refused.box.ready, false);
    assert.equal(await refused.box.show('helper'), 'the tools folder is not in place');
});

test('shown in each machine with its other folders, looked at by the health checks, and put back when it came loose', async (t) => {
    const b = bench(t);
    await b.box.prepare();
    assert.equal(await b.box.show('helper'), '');
    const again = bench(t, { mount: { code: 2, stderr: 'mount failed: "/tools" is already mounted' } });
    await again.box.prepare();
    assert.equal(await again.box.show('helper'), '', 'already there is not a failure');
    const broken = bench(t, { mount: { code: 2, stderr: 'mount failed: sshfs is not installed' } });
    await broken.box.prepare();
    assert.equal(await broken.box.show('helper'), 'mount failed: sshfs is not installed');
    /* With the other folders of a conversation (resources.mjs). */
    const resources = new Resources({ store: new Store(join(b.dir, 'resources.json')), vms: b.vms, host: b.host, dataDir: b.dir, uid: 994, gid: 985, toolbox: b.box });
    assert.deepEqual(resources.expected('helper', true), ['/work', '/tools']);
    assert.deepEqual(resources.expected('helper', false), ['/tools'], 'a machine that works on its own disk has the tools too');
    b.asked.length = 0;
    assert.deepEqual(await resources.remount('helper'), []);
    assert.deepEqual(b.asked, ['mount helper 994 985']);
    b.asked.length = 0;
    assert.equal(await resources.repair('helper', '/tools'), '');
    assert.deepEqual(b.asked, ['unmount helper', 'tools make', 'mount helper 994 985'], 'unmounted whatever the VM manager believes, its view made again, mounted again');
    /* Not in place: nothing is expected, nothing is mounted. */
    const none = new Resources({ store: new Store(join(b.dir, 'r2.json')), vms: b.vms, host: b.host, dataDir: b.dir, toolbox: new Toolbox({ host: b.host, vms: b.vms, mntDir: join(b.dir, 'other') }) });
    assert.deepEqual(none.expected('helper', true), ['/work']);
    assert.equal(existsSync(join(b.dir, 'other')), false);
});

/* A machine, as far as installing Parley goes: what `parley --version` says,
   whether npm is there, what sha256sum reads in /tools. */
function machine(b, { version = '', npm = true, sum, npmFails = false } = {}) {
    const m = { version, calls: [] };
    b.vms.exec = async (name, argv) => {
        m.calls.push(argv.join(' '));
        if (argv[0] === 'parley') return m.version ? { code: 0, stdout: `${m.version}\n`, stderr: '' } : { code: 127, stdout: '', stderr: 'parley: not found' };
        if (argv[0] === 'which') return { code: npm ? 0 : 1, stdout: npm ? '/usr/local/bin/npm\n' : '', stderr: '' };
        if (argv[0] === 'sha256sum') return { code: 0, stdout: `${sum ?? b.box.find('parley').sha256}  ${argv.at(-1)}\n`, stderr: '' };
        if (argv.includes('npm')) {
            if (npmFails) return { code: 1, stdout: '', stderr: 'npm ERR! code ENOTCACHED' };
            m.version = b.box.find('parley').version; return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return m;
}

test('Parley is installed by the server, in every machine: its sha256 read in the machine against the index, then npm offline, as root; once known there, nothing is asked', async (t) => {
    const b = bench(t);
    assert.equal(await b.box.installIn('helper'), 'the tools folder is not in place');
    await b.box.prepare();
    const parley = b.box.find('parley');
    const m = machine(b);
    assert.equal(await b.box.installIn('helper'), '');
    assert.deepEqual(m.calls, ['parley --version', 'which npm', `sha256sum -- ${parley.path}`, `sudo -n npm install -g --offline --no-audit --no-fund ${parley.path}`, 'parley --version']);
    /* Known there: an opening asks nothing of the machine. */
    m.calls.length = 0;
    assert.equal(await b.box.installIn('helper'), '');
    assert.deepEqual(m.calls, []);
    /* Two openings at once: one install. */
    b.box.forget('helper'); m.version = '0.0.1'; m.calls.length = 0;
    assert.deepEqual(await Promise.all([b.box.installIn('helper'), b.box.installIn('helper')]), ['', '']);
    assert.equal(m.calls.filter((c) => c.includes('npm install')).length, 1, 'an older version is replaced, once');
    /* Already the version of the index (a machine that kept its disk): looked at, not installed again. */
    b.box.forget('helper'); m.calls.length = 0;
    assert.equal(await b.box.installIn('helper'), '');
    assert.deepEqual(m.calls, ['parley --version']);
});

test('Parley is not installed from an archive that is not the one of the index, nor where there is no npm; npm failing is said', async (t) => {
    const b = bench(t);
    await b.box.prepare();
    const wrong = machine(b, { sum: '0'.repeat(64) });
    assert.match(await b.box.installIn('helper'), /is not the archive of the index \(sha256 differs\): not installed/);
    assert.equal(wrong.calls.some((c) => c.includes('npm install')), false, 'never installed');
    const none = machine(b, { npm: false });
    assert.equal(await b.box.installIn('helper'), 'there is no npm in this machine');
    assert.equal(none.calls.some((c) => c.includes('sha256sum')), false);
    /* Not asked again at each opening; looked at again once its machine was built again or restarted. */
    none.calls.length = 0;
    assert.equal(await b.box.installIn('helper'), 'there is no npm in this machine');
    assert.deepEqual(none.calls, []);
    b.box.forget('helper');
    machine(b, { npmFails: true });
    assert.equal(await b.box.installIn('helper'), 'npm: npm ERR! code ENOTCACHED');
    /* Not known to be there after a failure: tried again at the next opening. */
    const later = machine(b);
    assert.equal(await b.box.installIn('helper'), '');
    assert.ok(later.calls.some((c) => c.includes('npm install')));
});
