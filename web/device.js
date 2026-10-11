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

    /* WHAT THIS DEVICE HOLDS: a list of PAIRINGS, one per conversation shared
       with it. Each has its own key; the list says which one was used last.
         'pairings'        [ pairing id, ... ]
         'key:<id>'        the private key of that pairing
         'current'         the pairing shown
       (An earlier version held one pairing, as 'private' and 'device': it is
       taken over into the list the first time this runs.) */
    const all = async () => {
        let list = await stored('readonly', (keys) => keys.get('pairings'));
        if (!Array.isArray(list)) {
            list = [];
            const old = await stored('readonly', (keys) => keys.get('device'));
            const oldKey = old ? await stored('readonly', (keys) => keys.get('private')) : undefined;
            if (old && oldKey) {
                list = [old];
                await stored('readwrite', (keys) => { keys.put(oldKey, `key:${old}`); keys.put(list, 'pairings'); keys.put(old, 'current'); keys.delete('private'); keys.delete('device'); });
            }
        }
        return list;
    };
    const forget = async (id) => {
        const list = (await all()).filter((x) => x !== id);
        await stored('readwrite', (keys) => { keys.delete(`key:${id}`); keys.put(list, 'pairings'); });
        return list;
    };

    async function pair(code) {
        const pairKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const jwk = await crypto.subtle.exportKey('jwk', pairKeys.publicKey);
        const wide = Math.min(screen.width, screen.height) >= 600;
        const { device } = await post('/pair', { code, key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, label: wide ? 'Tablet or computer' : 'Phone' });
        const list = [...(await all()), device];
        await stored('readwrite', (keys) => { keys.put(pairKeys.privateKey, `key:${device}`); keys.put(list, 'pairings'); keys.put(device, 'current'); });
        return device;
    }

    async function session(id) {
        const privateKey = await stored('readonly', (keys) => keys.get(`key:${id}`));
        if (!privateKey) throw new Error('not paired');
        const { nonce } = await post('/challenge', { device: id });
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(nonce));
        await post('/session', { device: id, signature: b64url(signature) });
    }
    const nameOf = async (id) => {
        const r = await fetch(`${API}/${id}/me`);
        return r.ok ? (await r.json()).name : undefined;
    };

    /* Resolves with { ok: true, pairing, others: [{ pairing, name }] }, or
       { ok: false, message } to show. `others`: the other conversations this
       device holds, for the page to offer. */
    window.clavariumDoor = async () => {
        try {
            const code = location.hash.slice(1);
            let fresh;
            if (code) {
                /* The code is used once: it leaves the address bar at once. */
                history.replaceState(null, '', location.pathname);
                /* A new code always makes a new pairing, with a new key, ADDED
                   to what this device already holds. */
                fresh = await pair(code);
            }
            let list = await all();
            if (list.length === 0) return { ok: false, message: 'This device is not connected to a conversation. Ask the person who invited you for a new code to scan.' };
            /* Every pairing signs in; one that the owner removed, or whose
               conversation is gone, is dropped from this device quietly. */
            const held = [];
            for (const id of list) {
                try { await session(id); const name = await nameOf(id); if (name) held.push({ pairing: id, name }); else list = await forget(id); }
                catch (error) { if (/not paired|removed/.test(error.message)) list = await forget(id); else if (id === fresh) throw error; }
            }
            /* The same conversation shared twice with this device: the newest
               pairing stays, the older one is given back. */
            for (const h of [...held]) {
                const newer = held.filter((x) => x.name === h.name).pop();
                if (newer !== h) {
                    await fetch(`${API}/${h.pairing}/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
                    await forget(h.pairing); held.splice(held.indexOf(h), 1);
                }
            }
            if (held.length === 0) return { ok: false, message: 'This conversation was closed, or this device was removed from it. Ask the person who invited you for a new code to scan.' };
            const wanted = fresh ?? await stored('readonly', (keys) => keys.get('current'));
            const current = held.find((h) => h.pairing === wanted) ?? held[held.length - 1];
            await stored('readwrite', (keys) => keys.put(current.pairing, 'current'));
            return { ok: true, pairing: current.pairing, others: held.filter((h) => h !== current) };
        } catch (error) {
            /* Said for the person, with what to do next. */
            const known = /not paired|removed/.test(error.message) ? 'This conversation was closed, or this device was removed from it. Ask the person who invited you for a new code to scan.'
                : /not valid any more/.test(error.message) ? 'This code was already used, or is too old. Ask the person who invited you for a new one.' : error.message;
            return { ok: false, message: known };
        }
    };
    /* Shows another of this device's conversations: remembered, then the page starts over. */
    window.clavariumShowPairing = async (id) => { await stored('readwrite', (keys) => keys.put(id, 'current')); location.reload(); };
    /* Takes one conversation off this device: its key is destroyed here, and
       the server forgets the pairing. */
    window.clavariumLeave = async (id) => {
        await fetch(`${API}/${id}/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
        await forget(id);
    };
    /* The owner removed the pairing shown: forget its key, so that a new code can pair again. */
    window.clavariumForgetDevice = async () => { const id = await stored('readonly', (keys) => keys.get('current')); if (id) await forget(id); };
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
