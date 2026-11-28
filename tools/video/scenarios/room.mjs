/* DEMO: ONE ROOM, SEVERAL AIS. The person asks once; Mistral Vibe (on a European provider) keeps the confidential
 * part, hands over to Claude Code for the page, which hands over to Codex for the picture; each answer signed by
 * where it came from, the hand-overs capped. Plan: demos-plan #20. The room, its thread and the hand-overs are the
 * real server's; what each AI says is scripted (the agents of the bench are stand-ins). */
import { join } from 'node:path';
import { tool } from '../stage.mjs';

const AIS = [['Mistral Vibe', 'mistral-vibe', 'vibe'], ['Claude Code', 'claude-code', 'claude-code'], ['Codex', 'codex', 'codex']];

export default {
    name: 'room',
    title: 'One room, several AIs',
    opening: 'Several AIs. One thread.',
    page: 'rooms.html',
    formats: ['desk', 'phone'],
    tools: [tool('vibe', 'Mistral Vibe'), tool('claude-code', 'Claude Code'), tool('codex', 'Codex CLI')],
    lines: [
        'Ask once, in a room with several AIs.',
        'Each one takes the part it is best at, and hands over.',
        'Every answer is signed by the AI that gave it.',
        'Clavarium. Each AI for its strength.',
    ],
    gaps: [0.6, 0.5, 0.5, 0.6],

    async seed(b, me, { bridge }) {
        const agents = {};
        for (const [title, name, tl] of AIS) {
            const made = await me.api('/api/conversations', { title, tool: tl });
            if (made.status !== 201) throw new Error(`create ${name}: ${made.status}`);
        }
        for (const [, name] of AIS) {
            await me.until(`${name} is ready`, async () => (await me.api('/api/conversations')).body.find((c) => c.name === name)?.phase === 'ready', 90_000);
            await me.api(`/api/conversations/${name}/talk`, { on: true });
            agents[name] = bridge(join(b.dir, 'kept-work', name, 'work', '.parley'));
        }
        const room = (await me.api('/api/rooms', { name: 'Lys launch', conversations: AIS.map((a) => a[1]), host: 'mistral-vibe' })).body;
        if (!room?.id) throw new Error(`room: ${JSON.stringify(room)}`);
        const id = (ref) => room.members.find((m) => m.ref === ref || m.name === ref)?.id;
        return { agents, room, id };
    },

    async play(f, cue, { b, agents, room, id }) {
        const { page, tap, spot, badge, card, uncard, reveal } = f;
        await page.goto(`${b.origin}/?room=${room.id}`);
        const thread = page.locator('#salon-thread');
        await thread.waitFor({ state: 'visible', timeout: 8_000 }).catch(async () => {
            /* Picked in the list, as a person does. */
            await page.evaluate(() => { const app = document.getElementById('app'); if (app?.dataset.list === 'folded' && innerWidth > 700) document.getElementById('fold').click(); });
            const item = page.locator(`#list .room-item[data-room="${room.id}"]`).first();
            if (!(await item.isVisible().catch(() => false))) await page.locator('#back:visible').first().click().catch(() => {});
            await item.click({ timeout: 20_000 });
            await thread.waitFor({ state: 'visible', timeout: 30_000 });
        });
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        const box = thread.locator('textarea.parley-box').first();
        await tap(box, 400);
        await page.keyboard.type('Make a product page for our client Lys, with a picture. Their prices stay confidential.', { delay: 22 });
        await cue(0);
        /* Sent as a person does: Enter on a keyboard, the arrow on a touch screen (Enter is a new line there). */
        if (f.mobile) await tap(thread.locator('button.parley-send').first(), 500); else await page.keyboard.press('Enter');
        const said = thread.getByText('Their prices stay confidential').first();
        await said.waitFor({ timeout: 15_000 });
        await sleep(900);
        const roomId = room.id;
        /* What one AI hands to another is folded under "Between the AIs": opened, as a curious person does. */
        const shown = async (text) => {
            const l = thread.getByText(text).first();
            await l.waitFor({ state: 'attached', timeout: 15_000 });
            if (!(await l.isVisible())) await tap(thread.getByText(/^Between the AIs/).last(), 600);
            await l.waitFor({ state: 'visible', timeout: 10_000 });
            return l;
        };
        agents['mistral-vibe'].doing('Reading the price list, here in Europe', { room: roomId });
        await sleep(1400);
        agents['mistral-vibe'].tell('Confidential part done, in Europe: 3 products summed up in brief.md, prices left out. @Claude Code, can you build the page?', { room: roomId, to: [id('claude-code')] });
        const first = await shown('prices left out');
        await reveal(first);
        await cue(1);
        await spot(first, 1500);
        agents['claude-code'].doing('Building product.html', { room: roomId });
        await sleep(1500);
        agents['claude-code'].tell('Page built: product.html, 2 commits, no price in the code. @Codex, can you make the product picture?', { room: roomId, to: [id('codex')] });
        const second = await shown('no price in the code');
        await reveal(second);
        await spot(second, 1500);
        agents.codex.doing('Making the picture', { room: roomId });
        await sleep(1400);
        agents.codex.tell('The product picture is ready: product.png, in the page. Ready for your review.', { room: roomId });
        const last = thread.getByText('Ready for your review').first();
        await last.waitFor({ timeout: 15_000 });
        await reveal(last);
        await cue(2);
        await spot(page.locator('#salon-who'), 1300).catch(() => {});
        await spot(last, 1600);
        await cue(3);
        await card('Each AI for its strength.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
