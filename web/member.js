/* THE MEMBER'S PAGE (people.mjs, #419): the page of a paired device, for a person signed in whom an administrator
   made a member. No code, no key, no session of its own: who it is comes from the sign-in, checked by the server
   at each request. What it was given, and only that, is shown; the server refuses the rest whatever this page does. */
(() => {
    const KEPT = 'clavarium-member-current';
    const kept = () => { try { return localStorage.getItem(KEPT) ?? ''; } catch { return ''; } };
    /* Resolves as the device page's does: { ok, pairing, conversation, others: [{ pairing, name }] } or { ok: false, message }. */
    window.clavariumDoor = async () => {
        try {
            const r = await fetch('/m/api/me');
            if (r.status === 403 || r.status === 401) return { ok: false, message: 'This account may not use this page now. Ask an administrator.' };
            if (!r.ok) throw new Error(`The server answered ${r.status}.`);
            const me = await r.json();
            const names = Array.isArray(me.conversations) ? me.conversations : [];
            if (names.length === 0 && !(me.shared ?? []).length) return { ok: false, message: 'Nothing has been given to you yet. Ask an administrator to give you a conversation.' };
            const current = names.includes(kept()) ? kept() : (names[0] ?? null);
            return { ok: true, pairing: 'member', conversation: current, others: names.filter((n) => n !== current).map((name) => ({ pairing: 'member', name })) };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    };
    window.clavariumShowPairing = async (_id, name) => { try { localStorage.setItem(KEPT, name ?? ''); } catch { /* this visit only */ } location.reload(); };
    /* A member does not take a conversation off: an administrator does. */
    window.clavariumLeave = async () => {};
    window.clavariumForgetDevice = async () => {};
})();
