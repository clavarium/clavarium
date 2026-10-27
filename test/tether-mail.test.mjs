import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../server/vault.mjs';
import { Secrets } from '../server/secrets.mjs';
import { Store } from '../server/store.mjs';
import { Grants } from '../server/grants.mjs';
import { Vms } from '../server/vm.mjs';
import { Accounts } from '../server/accounts.mjs';
import { Tethers } from '../server/tethers.mjs';

/* END TO END, HOST SIDE: connect a mailbox by token, give it to a conversation,
   and let that conversation's .tether call run the mail connector -- proving the
   host-only token reaches the connector (host-side) and never the agent's folder. */
test('a granted mail target runs for a conversation with the token revealed host-side, never leaked to its folder', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vms = new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']);
    const secrets = new Secrets({ store: new Store(join(dir, 'secrets.json')), vault: new Vault(join(dir, 'vault.key')), vms, grants: new Grants() });

    /* A fake mail connector: it records the token it is handed and answers without
       ever printing it. (The real one opens IMAP; here we only prove the wiring.) */
    let sawToken;
    const mail = {
        name: 'mail', verbs: ['mail.list', 'mail.read', 'mail.search', 'mail.move', 'mail.flag', 'mail.send'],
        async run(verb, target, a, ctx) { sawToken = await ctx.secret('refresh'); return { text: 'INBOX: 2 messages', size: 17 }; },
        close() {}, shutdown() {},
    };

    /* Each conversation's work folder is a directory of its own. */
    const work = join(dir, 'work'); mkdirSync(work);
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha'], secrets, connectors: { mail } });

    /* Connect the account: makes the host-only token and a Tether mail target. */
    const accounts = new Accounts({ secrets, targets: { put: (spec) => tethers.store().putTarget(spec) },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'the-refresh-token', expires_in: 3600 }) }) });
    const { url } = accounts.consent({ provider: 'google', user: 'alice@example.com', kinds: ['mail'] });
    const state = new URL(url).searchParams.get('state');
    const { targets } = await accounts.connect({ redirected: `http://127.0.0.1:47813/?code=c&state=${state}` });
    const targetId = targets.find((x) => x.kind === 'mail').id;

    /* Give it to the conversation at "watch": a read verb runs without approval. */
    const grant = await tethers.act('level', { target: targetId, agent: 'conversation:alpha', level: 'watch' }, 'owner');
    assert.equal(grant.ok, true, grant.text);
    assert.deepEqual(tethers.given(), { alpha: 1 }, 'the conversation was given one target');

    /* The agent asks, through its .tether folder. */
    const side = join(work, 'alpha', '.tether');
    mkdirSync(side, { recursive: true });
    writeFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'q1', op: 'mail.list', args: { target: targetId, why: 'the morning mail' }, at: new Date().toISOString() })}\n`);

    /* The keeper takes it, runs the connector, and answers. */
    tethers.pump();
    const answersFile = join(side, 'answers.jsonl');
    for (let i = 0; i < 100 && !existsSync(answersFile); i++) await new Promise((r) => setTimeout(r, 5)); // eslint-disable-line no-await-in-loop
    for (let i = 0; i < 100; i++) { // eslint-disable-line no-await-in-loop
        if (existsSync(answersFile) && readFileSync(answersFile, 'utf8').split('\n').some((l) => l && JSON.parse(l).ask === 'q1' && JSON.parse(l).held !== true)) break;
        await new Promise((r) => setTimeout(r, 5)); // eslint-disable-line no-await-in-loop
    }
    const answers = readFileSync(answersFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const done = answers.find((x) => x.ask === 'q1' && x.held !== true);
    assert.ok(done, 'the ask was answered');
    assert.equal(done.ok, true, done.text);
    assert.match(done.text, /INBOX/);

    /* The point: the connector was handed the real token, host-side... */
    assert.equal(sawToken, 'the-refresh-token');
    /* ...and no file in the agent's folder ever carried it. */
    assert.ok(!readFileSync(answersFile, 'utf8').includes('the-refresh-token'), 'the answer never carries the token');
    assert.ok(!readFileSync(join(side, 'asks.jsonl'), 'utf8').includes('the-refresh-token'), 'the ask never carried it');
    /* And the secret is host-only: it cannot be attached to any conversation. */
    const tokenName = secrets.list().find((s) => s.hostOnly).name;
    assert.throws(() => secrets.attach('alpha', tokenName, true), /held by the server/);
});
