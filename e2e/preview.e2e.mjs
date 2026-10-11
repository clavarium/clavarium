import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A one-page PDF saying "Hello from a tool", built here with exact offsets. */
function smallPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        null,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const stream = 'BT /F1 18 Tf 20 100 Td (Hello from a tool) Tj ET';
    objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let out = '%PDF-1.4\n'; const offsets = [];
    objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}
/* A 2x2 red PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYQQwAHhYCAPmBfFgAAAAASUVORK5CYII=', 'base64');

/* Where on the page a piece of text of the terminal is: the middle of it. */
async function whereIs(page, text) {
    return page.evaluate((wanted) => {
        const t = window.clavariumTerminal; const buffer = t.buffer.active;
        for (let row = t.rows - 1; row >= 0; row--) {
            const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
            const col = line.lastIndexOf(wanted);
            if (col < 0) continue;
            const box = document.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: box.left + ((col + wanted.length / 2) * box.width) / t.cols, y: box.top + ((row + 0.5) * box.height) / t.rows };
        }
        return null;
    }, text);
}

test('a file is shown in the page: text as text, a picture as a picture, a PDF drawn page by page', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('viewer');
    const work = join(b.dir, 'kept-work', 'viewer', 'work');
    writeFileSync(join(work, 'summary.pdf'), smallPdf());
    writeFileSync(join(work, 'chart.png'), PNG);
    writeFileSync(join(work, 'page.html'), '<script>document.title = "ran"</script><h1 id="planted">not a page of this site</h1>');
    writeFileSync(join(work, 'data.bin'), Buffer.from([0, 1, 2, 3]));
    await me.page.locator('#files-open').click();
    const open = async (name) => { await me.page.locator('#files-rows .file', { hasText: name }).click(); };
    /* A PDF: drawn on a canvas by the page, never handed to the browser as a document. */
    await open('summary.pdf');
    await me.until('the page of the PDF is drawn', async () => (await me.page.locator('#preview-body canvas').count()) === 1 && /1 page\./.test(await me.page.locator('#preview-note').innerText()), 30_000);
    const inked = await me.page.evaluate(() => { const c = document.querySelector('#preview-body canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 0) dark++; return dark; });
    assert.ok(inked > 50, `the text is really drawn (${inked} dark points)`);
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#preview-download').click()]);
    assert.equal(download.suggestedFilename(), 'summary.pdf');
    await me.page.locator('#preview-back').click();
    /* A picture. */
    await open('chart.png');
    await me.until('the picture is shown', async () => me.page.evaluate(() => document.querySelector('#preview-body img')?.naturalWidth === 2));
    await me.page.locator('#preview-back').click();
    /* A web page written by a tool is TEXT here: nothing of it runs or is built. */
    await open('page.html');
    await me.until('its source is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('<h1 id="planted">'));
    assert.equal(await me.page.locator('#planted').count(), 0);
    assert.notEqual(await me.page.title(), 'ran');
    await me.page.locator('#preview-back').click();
    /* Anything else: said, and offered for download. */
    await open('data.bin');
    assert.match(await me.page.locator('#preview-note').innerText(), /not shown here\. Download it/);
    assert.deepEqual(me.errors, []);
});

test('a path the tool printed is clicked in the terminal and opens in Files, shown', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('pointer');
    await me.api('/api/resources', { name: 'reports' });
    await me.api('/api/conversations/pointer/resources', { resource: 'reports', access: 'write' });
    writeFileSync(join(b.dir, 'kept-work', 'pointer', 'work', 'summary.pdf'), smallPdf());
    await me.type('mkdir -p out; echo "figures" > out/q3.txt; echo "for the phone" > ../resources/reports/brief.txt; clear; echo "The PDF is ready: /work/summary.pdf (1 page)."; echo "See also /resources/reports/brief.txt, and the folder /work/out."; echo "Elsewhere: /etc/hostname"');
    await me.sees('Elsewhere: /etc/hostname');
    const click = async (text) => { const at = await whereIs(me.page, text); assert.ok(at, `${text} is on the screen`); await me.page.mouse.move(at.x, at.y); await me.page.mouse.click(at.x, at.y); };
    await click('/work/summary.pdf');
    await me.until('the PDF is shown in Files', async () => (await me.page.locator('#files').isVisible()) && (await me.page.locator('#preview-name').innerText()) === 'summary.pdf' && (await me.page.locator('#preview-body canvas').count()) === 1, 30_000);
    await me.page.locator('#files-close').click();
    /* A file of an attached folder. */
    await click('/resources/reports/brief.txt');
    await me.until('the text is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('for the phone'));
    assert.match(await me.page.locator('#files-tabs button[aria-selected=true]').innerText(), /reports/);
    await me.page.locator('#files-close').click();
    /* A folder is listed. */
    await click('/work/out');
    await me.until('the folder is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('q3.txt') && (await me.page.locator('#files-path').innerText()).replace(/\s+/g, '') === 'work/out');
    await me.page.locator('#files-close').click();
    /* Any other path of the machine is not a link: a click there opens nothing. */
    await click('/etc/hostname');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await me.page.locator('#files').isVisible(), false);
    assert.deepEqual(me.errors, []);
});

test('on a tablet, a finger on the path opens it too; and a file on the machine\'s own disk is said to be out of reach', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('by-finger', 'Shell', { onDisk: true });
    await me.type('echo x > made.txt; clear; echo "Ready: /work/made.txt"');
    await me.sees('Ready: /work/made.txt');
    const at = await whereIs(me.page, '/work/made.txt');
    await me.page.touchscreen.tap(at.x, at.y);
    await me.until('it says where the file is, and what to do', async () => /on the disk of the machine/.test(await me.page.locator('#notice-text').innerText()));
    assert.match(await me.page.locator('#notice-text').innerText(), /keep its work here/);
});
