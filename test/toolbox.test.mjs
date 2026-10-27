/* The tools at hand: a folder every machine sees at /tools, read-only, with
   an index; Parley's archive is the first thing in it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Toolbox, parleySource, toolSources, integrityOf, TOOLS_PATH } from '../server/toolbox.mjs';
import { packageFile, locked, MACHINE_TOOLS } from '../server/parley.mjs';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';

function bench(t, { make = 0, mount = { code: 0 }, sources } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tools-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked = [];
    const host = async (argv) => { asked.push(argv.join(' ')); return { code: make, stderr: make ? 'REFUSED: the tools folder is not what it should be' : '' }; };
    const vms = {
        mountTools: async (name, uid, gid) => { asked.push(`mount ${name} ${uid} ${gid}`); return typeof mount === 'function' ? mount() : mount; },
        unmountTools: async (name) => { asked.push(`unmount ${name}`); return { code: 0 }; },
    };
    const box = new Toolbox({ host, vms, mntDir: dir, uid: 994, gid: 985, ...(sources ? { sources } : {}) });
    return { dir, asked, box, vms, host };
}

test('Parley is the first tool: its archive as the registry served it, at the version installed, with the integrity npm recorded', () => {
    const [parley] = parleySource();
    assert.equal(parley.name, 'parley');
    const version = JSON.parse(readFileSync(packageFile('clavarium-parley', 'package.json'), 'utf8')).version;
    assert.ok(parley.archive.endsWith(`/toolbox/clavarium-parley-${version}.tgz`), parley.archive);
    assert.equal(readFileSync(parley.archive).subarray(0, 2).toString('hex'), '1f8b', 'a gzip archive');
    assert.equal(integrityOf(readFileSync(parley.archive)), locked('clavarium-parley').integrity, 'the archive npm recorded');
    assert.equal(version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies['clavarium-parley'], 'an exact version, from package.json');
    /* Installed by the server: nothing in the index asks a tool to install it. */
    assert.equal(parley.usage('/tools/x.tgz'), 'Installed in every machine: parley --help. Talk with the person you work for, on their screen, when their chat is on.');
});

test('an archive that is not the one npm recorded, or none, is not given to machines', async (t) => {
    const app = mkdtempSync(join(tmpdir(), 'clv-app-'));
    t.after(() => rmSync(app, { recursive: true, force: true }));
    const version = JSON.parse(readFileSync(packageFile('clavarium-parley', 'package.json'), 'utf8')).version;
    assert.deepEqual(parleySource({ app }), [], 'no archive: nothing');
    mkdirSync(join(app, 'toolbox'));
    writeFileSync(join(app, 'toolbox', `clavarium-parley-${version}.tgz`), 'not the archive');
    assert.deepEqual(parleySource({ app }), [], 'no lock file that records it: nothing');
    writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/clavarium-parley': locked('clavarium-parley') } }));
    const [source] = parleySource({ app });
    assert.equal(source.integrity, locked('clavarium-parley').integrity);
    const b = bench(t, { sources: [source] });
    const index = await b.box.prepare();
    assert.deepEqual(index.tools, [], 'the archive differs from what npm recorded: not offered');
});

test('the folder is made by the host program, then filled: each archive, and an index of name, version, checksum and usage', async (t) => {
    const b = bench(t);
    assert.equal(b.box.ready, false);
    assert.equal(b.box.find('parley'), undefined, 'nothing to offer before it is in place');
    const index = await b.box.prepare();
    assert.deepEqual(b.asked, ['tools make']);
    const files = join(b.dir, 'toolbox', 'files');
    /* Every tool of the machines, Parley first: its archive as npm recorded it, and one line of usage. */
    const sum = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const sources = toolSources();
    assert.deepEqual(sources.map((x) => x.name), MACHINE_TOOLS.map((x) => x.name));
    assert.deepEqual(index, { tools: sources.map((x) => { const file = x.archive.split('/').pop(); return { name: x.name, version: /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/.exec(file)[1], file, sha256: sum(x.archive), usage: MACHINE_TOOLS.find((m) => m.name === x.name).usage }; }) });
    for (const tool of index.tools) assert.equal(sum(join(files, tool.file)), tool.sha256);
    assert.equal(index.tools[0].usage, 'Installed in every machine: parley --help. Talk with the person you work for, on their screen, when their chat is on.');
    assert.match(index.tools[1].usage, /^Installed in every machine: docket --help\./);
    assert.deepEqual(JSON.parse(readFileSync(join(files, 'index.json'), 'utf8')), index, 'what a tool reads in /tools/index.json');
    const archive = index.tools[0].file;
    assert.equal(b.box.find('parley').path, `${TOOLS_PATH}/${archive}`);
    /* Prepared again: what is no longer listed goes, what is there is kept. */
    writeFileSync(join(files, 'clavarium-parley-0.0.1.tgz'), 'an old one');
    mkdirSync(join(files, 'stray'));
    await b.box.prepare();
    assert.deepEqual(readdirSync(files).sort(), [...index.tools.map((x) => x.file), 'index.json', 'launch'].sort());
    /* The launchers, as they are in config/launch of this code. */
    assert.deepEqual(readdirSync(join(files, 'launch')).sort(), readdirSync(new URL('../config/launch', import.meta.url)).sort());
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

/* A machine, as far as installing its tools goes: what `parley --version` and
   `docket --version` say, whether npm is there, what sha256sum reads in /tools. */
function machine(b, { versions = {}, npm = true, sum, npmFails = false } = {}) {
    const m = { versions: { ...versions }, calls: [] };
    const of = (path) => b.box.list().find((x) => path.endsWith(`/${x.file}`));
    b.vms.exec = async (name, argv) => {
        m.calls.push(argv.join(' '));
        if (['parley', 'docket', 'binder', 'tether'].includes(argv[0])) return m.versions[argv[0]] ? { code: 0, stdout: `${m.versions[argv[0]]}\n`, stderr: '' } : { code: 127, stdout: '', stderr: `${argv[0]}: not found` };
        if (argv[0] === 'which') return { code: npm ? 0 : 1, stdout: npm ? '/usr/local/bin/npm\n' : '', stderr: '' };
        if (argv[0] === 'sha256sum') return { code: 0, stdout: `${sum ?? of(argv.at(-1)).sha256}  ${argv.at(-1)}\n`, stderr: '' };
        if (argv.includes('npm')) {
            if (npmFails) return { code: 1, stdout: '', stderr: 'npm ERR! code ENOTCACHED' };
            const tool = of(argv.at(-1)); m.versions[tool.name] = tool.version; return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return m;
}

test('Parley and Docket are installed by the server, in every machine: each sha256 read in the machine against the index, then npm offline, as root; once known there, nothing is asked', async (t) => {
    const b = bench(t);
    assert.equal(await b.box.installIn('helper'), 'the tools folder is not in place');
    await b.box.prepare();
    const m = machine(b);
    assert.equal(await b.box.installIn('helper'), '');
    assert.deepEqual(m.calls, ['parley', 'docket', 'binder', 'tether'].flatMap((name) => { const tool = b.box.find(name); return [`${name} --version`, 'which npm', `sha256sum -- ${tool.path}`, `sudo -n npm install -g --offline --no-audit --no-fund ${tool.path}`, `${name} --version`]; }));
    /* Known there: an opening asks nothing of the machine. */
    m.calls.length = 0;
    assert.equal(await b.box.installIn('helper'), '');
    assert.deepEqual(m.calls, []);
    /* Two openings at once: one install. */
    b.box.forget('helper'); m.versions.parley = '0.0.1'; m.calls.length = 0;
    assert.deepEqual(await Promise.all([b.box.installIn('helper'), b.box.installIn('helper')]), ['', '']);
    assert.equal(m.calls.filter((c) => c.includes('npm install')).length, 1, 'an older version is replaced, once; the other is there already');
    /* Already the version of the index (a machine that kept its disk): looked at, not installed again. */
    b.box.forget('helper'); m.calls.length = 0;
    assert.equal(await b.box.installIn('helper'), '');
    assert.deepEqual(m.calls, ['parley --version', 'docket --version', 'binder --version', 'tether --version']);
});

test('a tool is not installed from an archive that is not the one of the index, nor where there is no npm; npm failing is said', async (t) => {
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

test('a launcher missing in its machine: /tools is mounted again and looked at again; still missing, it says why, and the tool is not started', async (t) => {
    let mounted = false;
    const b = bench(t, { mount: () => { mounted = true; return { code: 0 }; } });
    b.vms.exec = async (name, argv) => { b.asked.push(`exec ${name} ${argv.join(' ')}`); return { code: mounted ? 0 : 1 }; };
    await b.box.prepare();
    b.asked.length = 0;
    assert.equal(await b.box.launcherIn('demo', 'claude-code.sh'), '');
    assert.deepEqual(b.asked, ['exec demo test -r /tools/launch/claude-code.sh', 'unmount demo', 'tools make', 'mount demo 994 985', 'exec demo test -r /tools/launch/claude-code.sh']);
    /* There already: nothing else is asked. */
    b.asked.length = 0;
    assert.equal(await b.box.launcherIn('demo', 'claude-code.sh'), '');
    assert.deepEqual(b.asked, ['exec demo test -r /tools/launch/claude-code.sh']);
    /* It cannot be mounted: why, in words. */
    const c = bench(t, { mount: { code: 1, stderr: 'mount failed: no such device' } });
    c.vms.exec = async () => ({ code: 1 });
    await c.box.prepare();
    assert.equal(await c.box.launcherIn('demo', 'claude-code.sh'), '/tools could not be put in place: mount failed: no such device');
});

test('what its tool was started with: a tool started with older launchers is told once that a restart gives it the rest; one started before any record too; one without a launcher never', async (t) => {
    const b = bench(t);
    const dir = mkdtempSync(join(tmpdir(), 'clv-launched-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const launchers = join(dir, 'launch'); mkdirSync(launchers);
    writeFileSync(join(launchers, 'claude-code.sh'), 'exec "$@"\n');
    const launched = new Store(join(dir, 'launched.json'));
    const make = () => new Toolbox({ host: b.host, vms: b.vms, mntDir: join(dir, 'mnt'), launchers, launched, launches: (name) => name !== 'shell' });
    let box = make();
    await box.prepare();
    assert.equal(box.stale('old'), true, 'started before any record: older');
    box.told('old');
    assert.equal(box.stale('old'), false, 'told once');
    assert.equal(box.stale('shell'), false, 'no launcher: nothing to tell');
    box.started('fresh');
    assert.equal(box.stale('fresh'), false);
    /* An update: the launchers changed. */
    writeFileSync(join(launchers, 'claude-code.sh'), 'echo hooks\nexec "$@"\n');
    box = make();
    await box.prepare();
    assert.deepEqual([box.stale('fresh'), box.stale('old')], [true, true], 'both started with older launchers');
    box.told('fresh');
    assert.equal(box.stale('fresh'), false);
    box.started('old');
    assert.equal(box.stale('old'), false, 'restarted: it has them');
    /* Prepared again with the same launchers (a restart of this server): nothing said again. */
    box = make();
    await box.prepare();
    assert.deepEqual([box.stale('fresh'), box.stale('old')], [false, false]);
});
