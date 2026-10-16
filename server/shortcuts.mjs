/* SHORTCUTS: saved texts sent to the terminal with one click.
 *
 * Two kinds, and the difference is one flag:
 *   - enter: true   the text is typed, then Enter is pressed: it is SENT;
 *   - enter: false  the text is typed and left there, to be completed.
 *
 * A shortcut is keystrokes and nothing else. It goes through the same path as
 * the keyboard, so it works with every tool and gives the page no power the
 * person does not already have. */
import { randomUUID } from 'node:crypto';
import { Refusal } from './conversations.mjs';

export const SHORTCUTS_MAX = 30;
export const LABEL_MAX = 40;
export const TEXT_MAX = 2000;

const MARKER = 'seeded';

/* What a new installation starts with. */
export const DEFAULTS = [
    { label: 'Yes, go on', text: 'Yes, go on.', enter: true },
    { label: 'Run the tests', text: 'Run the tests and tell me what fails.', enter: true },
    { label: 'Summarise', text: 'Summarise what you did, in five lines.', enter: true },
];

/* One line of printable text: a line break inside would press Enter early. */
const oneLine = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max
    && ![...value].some((c) => { const p = c.codePointAt(0); return p < 0x20 || (p >= 0x7f && p < 0xa0); });

export class Shortcuts {
    #store;

    constructor(store) {
        this.#store = store;
        /* Seeded once. The marker stays, so that removing every shortcut does
           not bring the first ones back at the next start. */
        if (!store.get(MARKER)) {
            for (const d of DEFAULTS) store.put({ name: randomUUID(), ...d });
            store.put({ name: MARKER });
        }
    }

    #items() { return this.#store.all().filter((s) => s.name !== MARKER); }

    /* `starter`: one of the first ones, as they came, not the owner's own words. */
    list() { return this.#items().map(({ name, label, text, enter }) => ({ id: name, label, text, enter, ...(DEFAULTS.some((d) => d.label === label && d.text === text) ? { starter: true } : {}) })); }

    add({ label, text, enter }) {
        if (!oneLine(label, LABEL_MAX)) throw new Refusal(400, `A label is one line of at most ${LABEL_MAX} characters.`);
        if (!oneLine(text, TEXT_MAX)) throw new Refusal(400, `The text is one line of at most ${TEXT_MAX} characters.`);
        if (this.#items().some((x) => x.label === label.trim())) throw new Refusal(409, 'A shortcut already has this label.');
        if (this.#items().length >= SHORTCUTS_MAX) throw new Refusal(409, `There are already ${SHORTCUTS_MAX} shortcuts. Remove one first.`);
        const shortcut = { name: randomUUID(), label: label.trim(), text, enter: enter === true };
        this.#store.put(shortcut);
        return { id: shortcut.name, label: shortcut.label, text, enter: shortcut.enter };
    }

    remove(id) {
        if (id === MARKER || !this.#store.get(id)) throw new Refusal(404, 'No such shortcut.');
        this.#store.remove(id);
    }
}
