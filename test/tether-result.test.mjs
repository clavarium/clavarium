import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';

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
    await until(() => said.filter((e) => /^Accepted/.test(e.text)).length === 2);
    assert.ok(said.every((e) => !/handled/.test(e.text)), 'nothing said handled before the act');
    assert.deepEqual(said.filter((e) => /^Accepted/.test(e.text)).map((e) => [e.name, e.text, e.outcome]), [['alpha', 'Accepted: mail.send — being done', 'yes'], ['alpha', 'Accepted: mail.send — being done', 'yes']]);
    assert.ok(!said.some((e) => /^(Done|Failed)/.test(e.text)), 'no result before the act ended');

    release();
    await until(() => said.filter((e) => /^(Done|Failed)/.test(e.text)).length === 2);
    const done = said.find((e) => /^Done/.test(e.text));
    assert.equal(done.text, 'Done: mail.send');
    const failed = said.find((e) => /^Failed/.test(e.text));
    assert.match(failed.text, /^Failed: mail\.send — .*the mail server refused the recipient/);
    assert.equal(failed.tone, 'bad'); assert.equal(failed.level, 'needs-you', 'a failure after approval calls the person');
    assert.equal(failed.name, 'alpha');
});
