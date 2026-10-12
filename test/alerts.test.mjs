import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Alerts } from '../server/alerts.mjs';

function bench(t, fail = () => undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-alerts-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sent = [];
    const make = () => new Alerts({ store: new Store(join(dir, 'alerts.json')), keyFile: join(dir, 'keys.json'), subject: 'https://clav.example.com', send: async (subscription, payload, options) => { const error = fail(subscription); if (error) throw error; sent.push({ subscription, payload: JSON.parse(payload), options }); } });
    return { dir, sent, make, alerts: make() };
}
const device = (n = 1, host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/device-${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

test('this installation has a pair of keys of its own, made once and kept to itself', (t) => {
    const b = bench(t);
    const key = b.alerts.about().key;
    assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(b.make().about().key, key, 'the same after a restart');
    assert.equal(statSync(join(b.dir, 'keys.json')).mode & 0o077, 0, 'readable by this account only');
    assert.equal(JSON.stringify(b.alerts.about()).includes(JSON.parse(readFileSync(join(b.dir, 'keys.json'), 'utf8')).privateKey), false);
});

test('only a push service known here is ever called: an address from a browser is not trusted', (t) => {
    const b = bench(t);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.example.com/x', 'https://example.com/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', /* an address carrying a name before the host */ `https://${['someone', 'fcm.googleapis.com'].join('@')}/x`, 'file:///etc/passwd', 'not an address', '']) {
        assert.throws(() => b.alerts.add({ ...device(), endpoint }), /push service is not one this server calls|not a device/, endpoint);
    }
    assert.throws(() => b.alerts.add({ endpoint: device().endpoint, keys: { p256dh: 'x', auth: 'y' } }), /not a device/);
    assert.throws(() => b.alerts.add(undefined), /not a device/);
    for (const host of ['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com', 'db5p.notify.windows.com']) b.alerts.add(device(host.length, host), 'Tablet');
    assert.equal(b.alerts.about().devices.length, 4);
    b.alerts.add(device('fcm.googleapis.com'.length), 'Tablet again');
    assert.equal(b.alerts.about().devices.length, 4, 'the same device is one device');
    assert.equal(JSON.stringify(b.alerts.about()).includes('fcm.googleapis.com'), false, 'the page is not given the addresses back');
});

test('a message is a title, a line and a place in this site; a device that left is dropped; nothing ever throws', async (t) => {
    const b = bench(t, (s) => (s.endpoint.endsWith('device-2') ? Object.assign(new Error('gone'), { statusCode: 410 }) : s.endpoint.endsWith('device-3') ? new Error('network down') : undefined));
    for (const n of [1, 2, 3]) b.alerts.add(device(n), `Device ${n}`);
    const reached = await b.alerts.tell({ title: 'worker waits for you', body: `one\nline${'x'.repeat(400)}`, url: '/?c=worker' });
    assert.equal(reached, 1);
    assert.deepEqual(b.sent[0].payload, { title: 'worker waits for you', body: `one line${'x'.repeat(192)}`, url: '/?c=worker' });
    assert.equal(b.sent[0].options.vapidDetails.subject, 'https://clav.example.com');
    assert.equal(b.sent[0].options.urgency, 'high');
    assert.deepEqual(b.alerts.about().devices.map((d) => d.label), ['Device 1', 'Device 3'], 'the one the push service forgot is dropped; a passing failure is not');
    await b.alerts.tell({ title: 'x', body: '', url: 'https://elsewhere.example.com/' });
    assert.equal(b.sent[1].payload.url, '/', 'never a place outside this site');
    await b.alerts.tell({ title: 'x', body: '', url: '//elsewhere.example.com' });
    assert.equal(b.sent[2].payload.url, '/');
    b.alerts.remove(device(1).endpoint);
    assert.deepEqual(b.alerts.about().devices.map((d) => d.label), ['Device 3']);
});
