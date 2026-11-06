import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers, endedLine, resultLine } from '../server/tethers.mjs';

/* ACCEPTED IS NOT DONE (05-11): a call the owner accepts is said "being done" at the decision, then
   "Done" or "Failed -- why" once Tether journals the act -- never "handled" before the act. */
test('an accepted call is said being done, then done or failed when the act ends', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tres-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work'); mkdirSync(work);
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    let release; const gate = new Promise((r) => { release = r; });
    const mail = {
        name: 'mail', verbs: ['mail.send'],
        async run(verb, target, a) { await gate; if (a.subject === 'bad') throw new Error('the mail server refused the recipient'); return { text: 'Sent.', size: 0 }; },
        close() {}, shutdown() {},
    };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha'], secrets: { reveal: () => undefined }, connectors: { mail } });
    const said = [];
    tethers.announce = (name, e) => said.push({ name, ...e });
    tethers.store().putTarget({ id: 'box', title: 'Box', kind: 'mail', connector: 'mail' });
    tethers.store().grant('box', 'conversation:alpha', 'propose');
    const side = join(work, 'alpha', '.tether'); mkdirSync(side, { recursive: true });
    const ask = (id, subject) => appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id, op: 'mail.send', args: { target: 'box', to: 'bob@example.com', subject, body: 'hi', why: 'test' }, at: new Date().toISOString() })}\n`);
    const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn()); }; // eslint-disable-line no-await-in-loop
    const waiting = async () => (await tethers.act('state', {}, '')).data.approvals;

    ask('q1', 'good'); ask('q2', 'bad');
    tethers.pump();
    await until(() => said.filter((e) => e.kind === 'tether-demande').length === 2);
    for (const r of await waiting()) await tethers.act('decide', { id: r.id, decision: 'yes' }, ''); // eslint-disable-line no-await-in-loop
    /* Keys and values (Parley 0.17.71), with the plain English `t` an older screen says. */
    const plain = (e) => (typeof e.text === 'string' ? e.text : e.text?.t ?? '');
    const k = (e) => e.text?.k ?? '';
    await until(() => said.filter((e) => k(e) === 'line-accepted').length === 2);
    assert.ok(said.every((e) => !/handled/.test(plain(e))), 'nothing said handled before the act');
    assert.deepEqual(said.filter((e) => k(e) === 'line-accepted').map((e) => [e.name, e.text, e.outcome]),
        [['alpha', { k: 'line-accepted', v: { verb: 'mail.send' }, t: 'Accepted: mail.send — being done' }, 'yes'], ['alpha', { k: 'line-accepted', v: { verb: 'mail.send' }, t: 'Accepted: mail.send — being done' }, 'yes']]);
    assert.deepEqual(said.find((e) => k(e) === 'line-accepted').topic, { k: 'line-topic-request', t: 'Request' });
    assert.ok(!said.some((e) => /^line-(done|failed)/.test(k(e))), 'no result before the act ended');

    release();
    await until(() => said.filter((e) => /^line-(done|failed)/.test(k(e))).length === 2);
    const done = said.find((e) => k(e) === 'line-done');
    assert.deepEqual(done.text, { k: 'line-done', v: { verb: 'mail.send' }, t: 'Done: mail.send' });
    const failed = said.find((e) => k(e) === 'line-failed');
    assert.equal(failed.text.v.verb, 'mail.send');
    assert.match(failed.text.v.reason, /the mail server refused the recipient/, 'the reason as Tether gave it');
    assert.match(failed.text.t, /^Failed: mail\.send — .*the mail server refused the recipient/);
    assert.equal(failed.tone, 'bad'); assert.equal(failed.level, 'needs-you', 'a failure after approval calls the person');
    assert.equal(failed.name, 'alpha');
});

test('how a call ended, and its result, as words of the screen with their English', () => {
    assert.deepEqual(endedLine('mail.send', 'always'), { k: 'line-accepted', v: { verb: 'mail.send' }, t: 'Accepted: mail.send — being done' });
    assert.deepEqual(endedLine('mail.send', 'no'), { k: 'line-refused', v: { verb: 'mail.send' }, t: 'Refused: mail.send' });
    assert.deepEqual(endedLine('mail.send', 'timeout'), { k: 'line-timeout', v: { verb: 'mail.send' }, t: 'No answer in time: mail.send' });
    assert.deepEqual(endedLine('mail.send', 'withdrawn'), { k: 'line-withdrawn', v: { verb: 'mail.send' }, t: 'Withdrawn by the agent: mail.send' });
    assert.deepEqual(endedLine('mail.send', 'stopped'), { k: 'line-stopped', v: { verb: 'mail.send' }, t: 'Stopped: mail.send' });
    assert.deepEqual(endedLine('mail.send', ''), { k: 'line-handled', v: { verb: 'mail.send' }, t: 'Request handled: mail.send' });
    assert.deepEqual(resultLine('mail.send', ''), { k: 'line-failed-plain', v: { verb: 'mail.send' }, t: 'Failed: mail.send' });
});
