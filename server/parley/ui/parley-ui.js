/* THE EXCHANGE, SHOWN. One file, no framework, for any page.
 *
 *   import { mount, PROFILES } from './parley-ui.js';
 *   mount(element, { load, send, open, profile: PROFILES.simple });
 *
 *   load()                 resolves with { messages, waiting, status }
 *                          (what parley-host.mjs gives)
 *   send(text, answers)    the person wrote; `answers` is the id of the
 *                          question a choice answers
 *   open(path)             optional: opens a file the agent pointed to
 *   profile                how it looks and speaks for one kind of person
 *
 * EVERYTHING AN AGENT WROTE IS PUT ON THE PAGE AS TEXT, never as markup: it
 * is text chosen by a program.
 *
 * A PROFILE is the same screen for different people: the words on it, the
 * ready answers, how large it is, whether the agent's status is shown. It is
 * a plain object; a page can write its own.
 */
export const PROFILES = Object.freeze({
    /* For whoever wants nothing but a box and an answer. */
    simple: Object.freeze({ size: 'large', title: '', placeholder: 'Write what you want', send: 'Send', empty: 'Nothing yet. Write below.', quick: Object.freeze([]), showStatus: false, showFiles: true,
        states: Object.freeze({ working: 'It is working.', waiting: 'It is waiting for you.', done: 'It has finished.' }) }),
    /* An assistant for every day. */
    everyday: Object.freeze({ size: 'normal', title: '', placeholder: 'Ask, or say what you want done', send: 'Send', empty: 'Nothing yet.', quick: Object.freeze(['Yes, go on', 'Not now']), showStatus: true, showFiles: true,
        states: Object.freeze({ working: 'Working', waiting: 'Waiting for you', done: 'Done' }) }),
    /* For somebody who codes, next to a terminal. */
    coding: Object.freeze({ size: 'compact', title: '', placeholder: 'Instruction', send: 'Send', empty: 'No message yet.', quick: Object.freeze(['Yes, go on', 'Run the tests', 'Summarise']), showStatus: true, showFiles: true,
        states: Object.freeze({ working: 'working', waiting: 'waiting', done: 'done' }) }),
});

/* WHAT IS SHOWN, as plain data: the page is built from this and from nothing
   else, so it can be checked without a page. */
export function view(data, profile = PROFILES.everyday) {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const answered = new Set(messages.map((m) => m.answers).filter(Boolean));
    return {
        status: profile.showStatus && data?.status ? { state: data.status.state, text: `${profile.states[data.status.state] ?? data.status.state}${data.status.note ? ` - ${data.status.note}` : ''}` } : null,
        empty: messages.length === 0 ? profile.empty : null,
        items: messages.map((m) => ({
            id: String(m.id ?? ''), from: m.from === 'person' ? 'person' : 'agent', kind: m.kind,
            text: m.kind === 'show' ? [m.text, m.path].filter(Boolean).join(' ') : String(m.text ?? ''),
            file: m.kind === 'show' && profile.showFiles && m.path ? String(m.path) : null,
            choices: m.kind === 'ask' && !answered.has(m.id) ? (m.choices ?? []).map(String) : [],
            open: m.kind === 'ask' && !answered.has(m.id),
        })),
        quick: [...profile.quick],
    };
}

const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };

export function mount(root, { load, send, open, profile = PROFILES.everyday, every = 3000 } = {}) {
    root.classList.add('parley'); root.dataset.size = profile.size;
    const status = el('p', 'parley-status'); status.hidden = true; status.setAttribute('role', 'status');
    const thread = el('div', 'parley-thread'); thread.setAttribute('aria-live', 'polite');
    const quick = el('div', 'parley-quick');
    const form = el('form', 'parley-form'); form.autocomplete = 'off';
    const box = el('textarea', 'parley-box'); box.rows = 2; box.maxLength = 4000; box.placeholder = profile.placeholder; box.setAttribute('aria-label', profile.placeholder);
    const button = el('button', 'parley-send', profile.send); button.type = 'submit';
    const problem = el('p', 'parley-problem'); problem.hidden = true; problem.setAttribute('role', 'alert');
    form.append(box, button);
    root.replaceChildren(status, thread, quick, form, problem);
    let shown = '';
    const say = async (text, answers) => {
        problem.hidden = true;
        try { await send(text, answers); await refresh(); } catch (error) { problem.textContent = String(error?.message ?? error); problem.hidden = false; }
    };
    function paint(data) {
        const v = view(data, profile);
        const mark = JSON.stringify(v);
        if (mark === shown) return;
        shown = mark;
        status.hidden = !v.status; if (v.status) { status.textContent = v.status.text; status.dataset.state = v.status.state; }
        thread.replaceChildren(...v.items.map((item) => {
            const said = el('div', 'parley-said'); said.dataset.from = item.from; said.dataset.kind = item.kind; if (item.open) said.dataset.open = 'true';
            said.append(el('p', '', item.text));
            if (item.file && open) { const b = el('button', 'parley-open', 'Open it'); b.type = 'button'; b.addEventListener('click', () => open(item.file)); said.append(b); }
            if (item.choices.length > 0) {
                const row = el('div', 'parley-choices');
                for (const choice of item.choices) { const b = el('button', '', choice); b.type = 'button'; b.addEventListener('click', () => { for (const x of row.children) x.disabled = true; void say(choice, item.id); }); row.append(b); }
                said.append(row);
            }
            return said;
        }));
        if (v.empty) thread.append(el('p', 'parley-empty', v.empty));
        quick.replaceChildren(...v.quick.map((text) => { const b = el('button', '', text); b.type = 'button'; b.addEventListener('click', () => void say(text)); return b; }));
        quick.hidden = v.quick.length === 0;
        thread.scrollTop = thread.scrollHeight;
    }
    async function refresh() { try { paint(await load()); } catch { /* shown again at the next look */ } }
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = box.value.trim();
        if (!text) return;
        box.value = '';
        void say(text);
    });
    const timer = every > 0 ? setInterval(() => { if (!document.hidden) void refresh(); }, every) : null;
    void refresh();
    return { refresh, destroy() { if (timer) clearInterval(timer); root.replaceChildren(); root.classList.remove('parley'); } };
}
