/* THE DEVICE'S SIDE OF PAIRING. Loaded before the page's main script, which
   waits for `clavariumDoor()` to say the device has a session.
 *
 * The key pair is made HERE, and the private half is created non-extractable:
 * the browser will sign with it and will never hand it back, to this page or
 * to anyone. It lives in the browser's own database for this site.
 */
(() => {
    const API = '/c/api';
    const DB = 'clavarium-device';

    const database = () => new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
    const stored = async (mode, run) => {
        const db = await database();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('keys', mode);
            const request = run(tx.objectStore('keys'));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
        });
    };
    const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const post = async (path, body) => {
        const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'The request failed.');
        return j;
    };

    async function pair(code) {
        const pairKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const jwk = await crypto.subtle.exportKey('jwk', pairKeys.publicKey);
        const wide = Math.min(screen.width, screen.height) >= 600;
        const { device } = await post('/pair', { code, key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, label: wide ? 'Tablet or computer' : 'Phone' });
        await stored('readwrite', (keys) => { keys.put(pairKeys.privateKey, 'private'); keys.put(device, 'device'); });
        return device;
    }

    async function session(device) {
        const privateKey = await stored('readonly', (keys) => keys.get('private'));
        const { nonce } = await post('/challenge', { device });
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(nonce));
        await post('/session', { device, signature: b64url(signature) });
    }

    /* Resolves with { ok: true }, or { ok: false, message } to show. */
    window.clavariumDoor = async () => {
        try {
            const code = location.hash.slice(1);
            let device = await stored('readonly', (keys) => keys.get('device'));
            if (code) {
                /* The code is used once: it leaves the address bar at once. */
                history.replaceState(null, '', location.pathname);
                if (!device) device = await pair(code);
            }
            if (!device) return { ok: false, message: 'This device is not paired with a conversation. Ask its owner for a code to scan.' };
            await session(device);
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    };
    /* The owner removed this device: forget the key, so a new code can pair it. */
    window.clavariumForgetDevice = () => stored('readwrite', (keys) => { keys.delete('private'); keys.delete('device'); });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
