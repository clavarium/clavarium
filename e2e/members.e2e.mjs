/* ACCOUNTS AND RIGHTS in a browser (#419): an administrator makes an account a member and gives it one
   conversation; the member's page shows that one only. With SHOTS set (a folder), pictures of both, on a desktop
   and a phone, light and dark. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHome } from '../server/main.mjs';

const PW = process.env.CLAVARIUM_E2E_PLAYWRIGHT;
const SKIP = PW ? false : 'set CLAVARIUM_E2E_PLAYWRIGHT to a playwright-core folder';
const OWNER = 'owner@example.com'; const KID = 'kid@example.com';
const SHOTS = process.env.SHOTS ?? '';

test('an administrator gives a member one conversation; the member sees that one and nothing else', { skip: SKIP }, async (t) => {
    const { chromium } = await import(`${PW}/index.mjs`);
    const dir = mkdtempSync(join(tmpdir(), 'clv-members-e2e-'));
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify([
        { name: 'family', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept', chatName: 'Family' },
        { name: 'work', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept', chatName: 'Work' }]));
    const server = await startHome({ port: 0, host: ['true'], dataDir: dir, operators: [OWNER, KID] });
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); server.close(); rmSync(dir, { recursive: true, force: true }); });
    const as = async (who, viewport = { width: 1280, height: 800 }, colorScheme = 'light') => {
        const context = await browser.newContext({ viewport, colorScheme, extraHTTPHeaders: { 'x-forwarded-email': who } });
        const page = await context.newPage();
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        return { page, errors };
    };
    const until = async (what, fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { if (await fn().catch(() => false)) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await new Promise((r) => { setTimeout(r, 200); }); } };

    /* The administrator: the account made a member, then given Family's chat. */
    const admin = await as(OWNER);
    await admin.page.goto(`${base}/?open=settings&at=operators`);
    const kidRow = admin.page.locator(`#operators-rows [data-email="${KID}"]`);
    await until('the accounts listed', async () => (await kidRow.count()) === 1);
    assert.equal(await kidRow.locator('select.op-role').inputValue(), 'admin', 'as before: every account an administrator');
    await kidRow.locator('select.op-role').selectOption('member');
    await until('made a member, given nothing yet', async () => /Nothing shared yet/.test(await admin.page.locator('#operators-rows').innerText()));
    await admin.page.locator('#operators-rows select.op-give-add').selectOption('family');
    await until('given Family', async () => (await admin.page.locator('#operators-rows .op-given-line').count()) === 1);
    assert.match(await admin.page.locator('#operators-rows .op-given-line').innerText(), /Family/);
    assert.equal(await admin.page.locator('#operators-rows .op-given-line select').inputValue(), 'rw');
    assert.equal(await admin.page.locator('#operators-role').inputValue(), 'member', 'a new account comes as a member');
    await until('the head counts the member', async () => /1 administrator · 1 member/.test(await admin.page.locator('#settings-ch-operators summary').innerText()));
    if (SHOTS) await admin.page.locator('#settings-ch-operators').screenshot({ path: join(SHOTS, 'accounts-admin.png') });
    assert.deepEqual(admin.errors, []);

    /* The member, on a desktop and a phone, light and dark. */
    for (const [viewport, scheme] of [[{ width: 1280, height: 800 }, 'light'], [{ width: 390, height: 800 }, 'dark']]) {
        const kid = await as(KID, viewport, scheme);
        await kid.page.goto(`${base}/`);
        await until('its own page', async () => new URL(kid.page.url()).pathname === '/m/');
        await until('Family shown', async () => /family|Family/.test(await kid.page.locator('#name').innerText()));
        const text = await kid.page.locator('body').innerText();
        assert.doesNotMatch(text, /\bWork\b/, 'nothing of what it was not given');
        assert.equal(await kid.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'nothing wider than the screen');
        /* The administrators' page is not its own, even asked for by its address. */
        const refused = await kid.page.request.get(`${base}/api/conversations`);
        assert.equal(refused.status(), 403);
        if (SHOTS) await kid.page.screenshot({ path: join(SHOTS, `accounts-member-${viewport.width}-${scheme}.png`) });
        assert.deepEqual(kid.errors, [], `${viewport.width} ${scheme}`);
        await kid.page.context().close();
    }
});
