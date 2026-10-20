/* The operators from the page (server/operators.mjs): through the host program, the gate kept up to date, locked after failed sign-ins. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operators, newPassword, FAILS_MAX, LOCK_MIN } from '../server/operators.mjs';
import { makeGate } from '../server/gate.mjs';
import { Store } from '../server/store.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-team-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const people = new Map([['owner@example.com', true]]);
    let failures = '';
    const asked = [];
    const host = async (argv, options = {}) => {
        asked.push({ argv: argv.join(' '), input: options.input });
        const [, verb, email] = argv;
        if (verb === 'list') return { code: 0, stdout: [...people].map(([e, on]) => `${e}\t${on ? 'enabled' : 'disabled'}`).join('\n'), stderr: '' };
        if (verb === 'failures') return { code: 0, stdout: failures, stderr: '' };
        if (verb === 'add') { people.set(email, true); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'disable') { if ([...people.values()].filter(Boolean).length === 1) return { code: 78, stdout: '', stderr: 'REFUSED: the last operator cannot be disabled' }; people.set(email, false); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'enable') { people.set(email, true); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'remove') { people.delete(email); return { code: 0, stdout: '', stderr: '' }; }
        return { code: 0, stdout: '', stderr: '' };
    };
    let clock = 1_000_000_000_000; const told = [];
    const team = new Operators({ host, store: new Store(join(dir, 'operators.json')), initial: ['owner@example.com'], now: () => clock });
    team.useAlerts({ tell: async (m) => { told.push(m); } });
    const gate = makeGate(() => team.allowed());
    const as = (email) => gate({ 'x-forwarded-email': email });
    return { team, gate, as, asked, told, people, setFailures: (f) => { failures = f; }, later: (min) => { clock += min * 60_000; } };
}

test('an operator added comes in at once, with a password shown once and sent on standard input only; disabled or removed, out at once', async (t) => {
    const b = bench(t);
    assert.equal(b.as('second@example.com'), undefined);
    const made = await b.team.add('Second@Example.com');
    assert.equal(made.email, 'second@example.com');
    assert.match(made.password, /^([a-zA-Z2-9]{6}-){3}[a-zA-Z2-9]{6}$/);
    const add = b.asked.find((x) => x.argv.startsWith('operator add'));
    assert.equal(add.argv, 'operator add second@example.com', 'never on the command line');
    assert.equal(add.input, `${made.password}\n`);
    assert.equal(b.as('second@example.com'), 'second@example.com', 'in, without a restart');
    assert.ok(!JSON.stringify(b.team.list()).includes(made.password), 'never shown again');
    await b.team.disable('second@example.com');
    assert.equal(b.as('second@example.com'), undefined, 'out at once, even with a session open');
    await b.team.enable('second@example.com');
    assert.equal(b.as('second@example.com'), 'second@example.com');
    await b.team.remove('second@example.com');
    assert.equal(b.as('second@example.com'), undefined);
    await assert.rejects(b.team.disable('owner@example.com'), /last operator/);
    await assert.rejects(b.team.add('not an address'), /e-mail address/);
    assert.notEqual(newPassword(), newPassword());
});

test(`${FAILS_MAX} failed sign-ins lock an address for ${LOCK_MIN} minutes, said to the owner; lifted by itself after; the last operator is never locked out`, async (t) => {
    const b = bench(t);
    await b.team.add('second@example.com');
    b.setFailures(`second@example.com\t${FAILS_MAX}\nowner@example.com\t2\n`);
    await b.team.watch();
    assert.equal(b.as('second@example.com'), undefined, 'locked');
    assert.ok(b.team.list().find((o) => o.email === 'second@example.com').locked);
    assert.equal(b.as('owner@example.com'), 'owner@example.com', 'the other one goes on');
    assert.match(b.told[0].title, /second@example\.com is locked for 15 minutes/);
    b.setFailures('');
    b.later(LOCK_MIN + 1); await b.team.watch();
    assert.equal(b.as('second@example.com'), 'second@example.com', 'lifted by itself');
    /* The last enabled one: told, not locked. */
    await b.team.remove('second@example.com');
    b.setFailures(`owner@example.com\t${FAILS_MAX + 3}\n`);
    await b.team.watch();
    assert.equal(b.as('owner@example.com'), 'owner@example.com');
    assert.match(b.told.at(-1).body, /last operator: not locked out/);
});
