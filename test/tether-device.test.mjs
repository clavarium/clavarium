import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers, USB_DEVICE } from '../server/tethers.mjs';

test('the USB device is offered once to each conversation at "propose"; taken back, it stays taken back', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tdev-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work'); mkdirSync(work);
    const names = ['alpha'];
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const make = () => new Tethers({ dataDir: dir, resources, conversations: () => names, secrets: { reveal: () => undefined } });
    let tethers = make();
    await tethers.act('state', {}, '');
    const level = () => tethers.store().target(USB_DEVICE).grants['conversation:alpha']?.level;
    assert.equal(tethers.store().target(USB_DEVICE).kind, 'device');
    assert.equal(level(), 'propose');
    tethers.store().grant(USB_DEVICE, 'conversation:alpha', null);
    names.push('beta');
    tethers = make();
    await tethers.act('state', {}, '');
    assert.equal(level(), undefined, 'taken back by the owner, not offered again');
    assert.equal(tethers.store().target(USB_DEVICE).grants['conversation:beta']?.level, 'propose');
});
