import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const at = (s) => new Date(Date.now() - 120_000 + s * 1000).toISOString();
const line = (id, s, rest) => `${JSON.stringify({ id: `${id}-0000-4000-8000-000000000000`.slice(0, 36), at: at(s), ...rest })}\n`;

/* The tool can write in /work/.parley: the server shows its own copy of the thread, and says where it changed. */
test('the thread is kept by the server: a line the tool rewrites, or a message of the owner it deletes, is shown as it was, with one short line where it changed; archived, the copy goes', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('notes');
    assert.equal((await me.api('/api/conversations/notes/talk', { on: true })).status, 200);
    const bridge = join(b.dir, 'data', 'work', 'notes', '.parley');
    writeFileSync(join(bridge, 'from-agent.jsonl'), line('a1', 0, { kind: 'say', text: 'I will only read the database.' }));
    await me.page.goto(`${b.origin}/?c=notes`);
    const thread = me.page.locator('#simple-thread');
    const said = async () => (await thread.locator('.parley-said[data-from=agent] .parley-md, .parley-said[data-from=person] .parley-text').allInnerTexts()).map((x) => x.trim());
    await me.until('its message', async () => (await said()).join('|') === 'I will only read the database.');
    await me.page.fill('#simple-thread .parley-box', 'Fine, read only.');
    await me.page.locator('#simple-thread .parley-send').click();
    await me.until('the owner\'s message', async () => (await said()).join('|') === 'I will only read the database.|Fine, read only.');
    const kept = join(b.dir, 'data', 'talk-kept', 'notes');
    assert.match(readFileSync(join(kept, 'to-agent.jsonl'), 'utf8'), /Fine, read only\./, 'kept in the data of the server, not in the machine');
    /* The tool rewrites what it said, and takes away what its owner said. */
    const out = join(bridge, 'from-agent.jsonl');
    writeFileSync(out, readFileSync(out, 'utf8').replace('only read the database', 'drop the database'));
    writeFileSync(join(bridge, 'to-agent.jsonl'), '');
    const notice = thread.locator('.parley-system', { hasText: 'History changed here: original shown' });
    await me.until('said in the thread, where each changed', async () => (await notice.count()) === 2, 30_000);
    assert.deepEqual(await said(), ['I will only read the database.', 'Fine, read only.'], 'the copy kept is shown');
    assert.equal(await thread.innerText().then((x) => x.includes('drop the database')), false);
    /* What it posts next is shown as usual. */
    writeFileSync(out, readFileSync(out, 'utf8') + line('a2', 200, { kind: 'say', text: 'Read, nothing changed.' }));
    await me.until('its next message', async () => (await said()).at(-1) === 'Read, nothing changed.', 30_000);
    assert.equal(await notice.count(), 2, 'said once each');
    /* Archived: the copy goes with it. */
    assert.equal((await me.api('/api/conversations/notes/archive', {})).status, 200);
    assert.equal(existsSync(kept), false);
});
