/* QUICK ACTIONS ON A CARD (02-11): at most three, from a FIXED catalogue -- so nothing is invented that the
 * page cannot do. Rules first (a passed due date, a mail attached, a file attached), then, when the small
 * fast chat model of the dictation service is set, its choice among the same keys, each with a short why.
 * What is done with them is the page's: a change on the card itself (undone in a click), or a request to
 * the assistant carrying it, in its chat (where the person follows and approves). Nothing leaves alone. */

export const CATALOGUE = Object.freeze({
    done: { label: 'Mark it done', on: 'card' },
    'postpone-day': { label: 'Postpone to tomorrow', on: 'card' },
    'postpone-week': { label: 'Postpone a week', on: 'card' },
    'urgency-up': { label: 'More urgent', on: 'card' },
    'urgency-down': { label: 'Less urgent', on: 'card' },
    /* A card no longer of use, or one an AI made by mistake: archived (restored in a click), never deleted here. */
    archive: { label: 'Archive it', on: 'card' },
    'reply-mail': { label: 'Draft the reply to the mail', on: 'agent', ask: 'Draft a reply to the mail attached to this card. Keep it as a draft: show it to me before anything is sent.' },
    'make-event': { label: 'Put it in the calendar', on: 'agent', ask: 'Create the calendar event this card speaks of (ask me before it is created).' },
    split: { label: 'Split into smaller cards', on: 'agent', ask: 'Split this card into a few smaller cards, each one step, in the same binder.' },
    summarise: { label: 'Summarise what is attached', on: 'agent', ask: 'Summarise what is attached to this card, in a note on it.' },
    related: { label: 'Find related cards', on: 'agent', ask: 'Find the cards related to this one and attach them to it.' },
});
const KEYS = Object.keys(CATALOGUE);

/* Without a model: what the card plainly calls for. */
export function rulesFor(record, now = Date.now()) {
    const out = [];
    const attached = Array.isArray(record?.attached) ? record.attached : [];
    if (record?.due && Date.parse(record.due) < now) out.push({ key: 'postpone-day', why: 'its due date has passed' });
    if (attached.some((a) => a.kind === 'mail')) out.push({ key: 'reply-mail', why: 'a mail is attached' });
    if (attached.some((a) => a.kind === 'file')) out.push({ key: 'summarise', why: 'files are attached' });
    return out;
}

/* What a model answered, kept only when it is the catalogue's: three at most, no repeat, a short why. */
export function pickedOf(text) {
    let list;
    try { const t = String(text ?? ''); list = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)); } catch { return []; }
    if (!Array.isArray(list)) return [];
    const seen = new Set(); const out = [];
    for (const a of list) {
        const key = String(a?.key ?? ''); if (!KEYS.includes(key) || seen.has(key)) continue;
        seen.add(key); out.push({ key, why: String(a?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) });
        if (out.length === 3) break;
    }
    return out;
}

/* The card in a few lines for the model: never more than it needs. */
export function cardText(record, list) {
    const fields = Object.entries(record?.fields ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
    const attached = (record?.attached ?? []).map((a) => `${a.kind}: ${String(a.title ?? a.ref ?? '').slice(0, 80)}`).join('; ');
    return [`Binder: ${String(list?.title ?? '').slice(0, 80)}`, `Title: ${String(record?.title ?? '').slice(0, 200)}`,
        record?.description ? `Description: ${String(record.description).slice(0, 1200)}` : '', record?.due ? `Due: ${record.due}` : '',
        fields ? `Fields: ${fields}` : '', attached ? `Attached: ${attached}` : '', `Today: ${new Date().toISOString().slice(0, 10)}`].filter(Boolean).join('\n');
}

export const SUGGEST_SYSTEM = `You suggest quick actions for a to-do card. Choose AT MOST 3 keys from this list, the most useful first, only those that clearly fit the card: ${KEYS.map((k) => `${k} (${CATALOGUE[k].label})`).join(', ')}. Suggest archive when the card no longer matters, is a duplicate, or looks made by mistake. Answer ONLY with JSON: [{"key": "...", "why": "a reason of 2 to 6 words, in the card's language"}]. No other text.`;

/* -> [{ key, label, why, on, ask? }] -- the model's choice when it answers, else the rules'. */
export async function suggest(record, list, { chat = null, now = Date.now() } = {}) {
    let picked = [];
    if (chat) { try { picked = pickedOf(await chat(SUGGEST_SYSTEM, cardText(record, list))); } catch { picked = []; } }
    if (!picked.length) picked = rulesFor(record, now).slice(0, 3);
    return picked.map((p) => ({ key: p.key, label: CATALOGUE[p.key].label, why: p.why, on: CATALOGUE[p.key].on, ...(CATALOGUE[p.key].ask ? { ask: CATALOGUE[p.key].ask } : {}) }));
}
