/* ONE PROGRAM FOR ALL THE TOOLS OF A CONVERSATION (11-11, #350): the agent starts mcp-sock.sh for each tool; the
   sessions run as worker threads of one tools-host.mjs. A tool runs unchanged (its own argv, stdin, stdout); a
   version installed under a session is taken up between two requests; a tool that crashes takes nothing else
   down; the host's folder closed to others or nothing served; no netcat: the relay of before. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const LAUNCH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'launch');
const NC = spawnSync('sh', ['-c', 'command -v nc'], { encoding: 'utf8' }).status === 0;

/* A tool as the real ones are: newline JSON-RPC on stdin/stdout; its version from its package.json; "boom" ends it. */
const TOOL = `import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const dir = process.argv[process.argv.indexOf('--dir') + 1];
createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'boom') throw new Error('boom');
    if (m.id === undefined) return;
    const result = m.method === 'initialize' ? { serverInfo: { name: 'fake', version } } : { tools: [{ name: 'echo' }], version, dir, argv1: process.argv[1] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

function bench(t) {
    const root = mkdtempSync(join(tmpdir(), 'tools-host-'));
    const run = join(root, 'run'); mkdirSync(run);
    const pkg = join(root, 'fake'); mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fake', version: '1.0.0' }));
    writeFileSync(join(pkg, 'tool.mjs'), TOOL);
    const kids = [];
    t.after(() => {
        for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
        const log = join(run, `clavarium-tools-${process.getuid()}`, 'host.log');
        const pid = existsSync(log) ? /listening \((\d+)\)/.exec(readFileSync(log, 'utf8'))?.[1] : null;
        if (pid) { try { process.kill(Number(pid)); } catch { /* gone */ } }
    });
    /* One session through the bridge: send a message, wait for the answer of an id. */
    const session = (env = {}) => {
        const c = spawn('/bin/sh', [join(LAUNCH, 'mcp-sock.sh'), 'node', join(pkg, 'tool.mjs'), '--dir', '/work/.x'], { env: { ...process.env, XDG_RUNTIME_DIR: run, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        kids.push(c);
        const seen = [];
        const waiting = new Map();
        createInterface({ input: c.stdout }).on('line', (line) => { const m = JSON.parse(line); seen.push(m); waiting.get(m.id)?.(m); });
        const ask = (m) => new Promise((ok, no) => { const timer = setTimeout(() => no(new Error(`no answer to ${m.method}`)), 8000); waiting.set(m.id, (x) => { clearTimeout(timer); ok(x); }); c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`); });
        const tell = (m) => c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
        return { c, ask, tell, seen };
    };
    return { root, run, pkg, session };
}

test('a tool through the shared host: answered from a worker of one program, the same argv; a new version taken up between two requests', { skip: !NC && 'no netcat here' }, async (t) => {
    const b = bench(t);
    const s = b.session();
    const hello = await s.ask({ id: 1, method: 'initialize', params: {} });
    assert.equal(hello.result.serverInfo.version, '1.0.0');
    s.tell({ method: 'notifications/initialized' });
    const listed = await s.ask({ id: 2, method: 'tools/list' });
    assert.equal(listed.result.dir, '/work/.x', 'its own arguments');
    assert.equal(listed.result.argv1, join(b.pkg, 'tool.mjs'), 'its own file as argv[1], as when started alone');
    const dir = join(b.run, `clavarium-tools-${process.getuid()}`);
    assert.equal(readFileSync(join(dir, 'host.log'), 'utf8').match(/listening/g).length, 1, 'one host');
    /* A second tool session: the same host, not a second one. */
    const other = b.session();
    assert.equal((await other.ask({ id: 1, method: 'initialize', params: {} })).result.serverInfo.version, '1.0.0');
    assert.equal(readFileSync(join(dir, 'host.log'), 'utf8').match(/listening/g).length, 1, 'still one host');
    /* Installed under the session: the next request goes to the new version, the session told. */
    writeFileSync(join(b.pkg, 'package.json'), JSON.stringify({ name: 'fake', version: '2.0.0' }));
    const again = await s.ask({ id: 3, method: 'tools/list' });
    assert.equal(again.result.version, '2.0.0');
    assert.ok(s.seen.some((m) => m.method === 'notifications/tools/list_changed'));
});

test('a tool that crashes takes nothing else down; a folder open to others serves nothing; no netcat, the relay of before', { skip: !NC && 'no netcat here' }, async (t) => {
    const b = bench(t);
    const a = b.session(); const c = b.session();
    await a.ask({ id: 1, method: 'initialize', params: {} }); a.tell({ method: 'notifications/initialized' });
    await c.ask({ id: 1, method: 'initialize', params: {} }); c.tell({ method: 'notifications/initialized' });
    a.tell({ id: 9, method: 'boom' });
    const failed = await new Promise((ok) => { const i = setInterval(() => { const m = a.seen.find((x) => x.id === 9); if (m) { clearInterval(i); ok(m); } }, 50); });
    assert.match(failed.error.message, /stopped/);
    assert.equal((await c.ask({ id: 2, method: 'tools/list' })).result.version, '1.0.0', 'the other session goes on');
    assert.equal((await a.ask({ id: 10, method: 'tools/list' })).result.version, '1.0.0', 'the crashed one starts again');
    /* Its folder open to others: the host refuses it. */
    const open = mkdtempSync(join(tmpdir(), 'tools-open-')); chmodSync(open, 0o755);
    const refused = spawnSync(process.execPath, [join(LAUNCH, 'tools-host.mjs'), open], { encoding: 'utf8', timeout: 5000 });
    assert.equal(refused.status, 77);
    /* No netcat on the PATH: the relay of before answers all the same. */
    const nodeDir = join(b.root, 'node'); mkdirSync(nodeDir);
    spawnSync('ln', ['-s', process.execPath, join(nodeDir, 'node')]);
    for (const tool of ['dirname', 'id', 'mkdir', 'chmod', 'sed', 'cat', 'flock', 'sleep']) {
        const at = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        if (at) spawnSync('ln', ['-s', at, join(nodeDir, tool)]);
    }
    const bare = b.session({ PATH: `${nodeDir}:/nonexistent`, XDG_RUNTIME_DIR: join(b.root, 'other') });
    assert.equal((await bare.ask({ id: 1, method: 'initialize', params: {} })).result.serverInfo.version, '1.0.0');
});
