/* What a conversation does when its machine is short (server/healthreact.mjs): chosen, never by default; once per problem. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthReact, DEFAULT_MESSAGE } from '../server/healthreact.mjs';
import { Store } from '../server/store.mjs';

function bench(t, agent = true) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-react-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const said = []; const ran = []; const events = [];
    const r = new HealthReact({ store: new Store(join(dir, 'react.json')), say: async (name, line) => { said.push(line); return true; }, exec: async (name, argv) => { ran.push(argv); return { code: 0, stdout: 'freed 2 GB\n', stderr: '' }; }, isAgent: () => agent, event: (name, line) => events.push(line.text) });
    return { r, said, ran, events };
}
const short = { state: 'Running', problems: [{ level: 'warn', kind: 'disk', key: 'disk:/', text: 'Its disk is almost full: 900 MB left of 8000 MB.' }] };
const well = { state: 'Running', problems: [] };

test('off by default: nothing said, nothing run; on, its agent is told once per problem, in the line the owner chose', async (t) => {
    const b = bench(t);
    await b.r.judged('site', short);
    assert.deepEqual([b.said, b.events], [[], []], 'never by default');
    assert.equal(b.r.settings('site').message, DEFAULT_MESSAGE);
    b.r.set('site', { on: true, message: 'Low on room: {problem} Clean your caches.' });
    await b.r.judged('site', short);
    assert.deepEqual(b.said, ['Low on room: Its disk is almost full: 900 MB left of 8000 MB. Clean your caches.']);
    assert.match(b.events[0], /^Said to its agent: Low on room/);
    await b.r.judged('site', short);
    assert.equal(b.said.length, 1, 'once: not in a loop');
    await b.r.judged('site', well);
    await b.r.judged('site', short);
    assert.equal(b.said.length, 2, 'gone, then back: said again');
    /* A machine not looked at inside (asleep): not known to be gone. */
    await b.r.judged('site', { state: 'Suspended', problems: [] });
    await b.r.judged('site', short);
    assert.equal(b.said.length, 2);
    assert.throws(() => b.r.set('site', { message: 'two\nlines' }), /one line/);
    assert.throws(() => b.r.set('site', { on: 'yes' }), /true or false/);
});

test('a tool with no agent: the owner\'s command is run in its machine, bounded, what it said is in its chat; no command, nothing', async (t) => {
    const b = bench(t, false);
    b.r.set('box', { on: true });
    await b.r.judged('box', short);
    assert.deepEqual(b.ran, [], 'no command chosen');
    b.r.set('box', { command: 'rm -rf ~/.cache/*' });
    await b.r.judged('box', well); await b.r.judged('box', short);
    assert.deepEqual(b.ran[0].slice(0, 5), ['timeout', '-k', '10', '120', 'sh']);
    assert.equal(b.ran[0].at(-1), 'rm -rf ~/.cache/*');
    assert.match(b.events.at(-1), /^Ran: rm -rf ~\/\.cache\/\* \(exit 0\): freed 2 GB$/);
    assert.equal(b.said.length, 0);
});
