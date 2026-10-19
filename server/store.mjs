/* WHAT IS REMEMBERED ABOUT CONVERSATIONS: one small JSON file.
 *
 * Deliberately not a database. The terminal's content lives in tmux, the
 * tool's history lives in the tool, the files live in folders: what is left
 * is a list of names and settings. Written whole, to a temporary file, then
 * renamed over the old one, so a crash leaves the old file or the new one. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
    #path;
    #items;

    constructor(path) {
        this.#path = path;
        mkdirSync(dirname(path), { recursive: true });
        try { this.#items = JSON.parse(readFileSync(path, 'utf8')); } catch { this.#items = []; }
        if (!Array.isArray(this.#items)) this.#items = [];
    }

    all() { return this.#items.map((c) => ({ ...c })); }
    get(name) { const c = this.#items.find((x) => x.name === name); return c ? { ...c } : undefined; }

    put(conversation) {
        const i = this.#items.findIndex((x) => x.name === conversation.name);
        if (i >= 0) this.#items[i] = { ...conversation }; else this.#items.push({ ...conversation });
        this.#save();
    }

    patch(name, changes) {
        const c = this.#items.find((x) => x.name === name);
        if (!c) return undefined;
        Object.assign(c, changes);
        this.#save();
        return { ...c };
    }

    remove(name) {
        this.#items = this.#items.filter((x) => x.name !== name);
        this.#save();
    }

    #save() {
        const tmp = `${this.#path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.#items, null, 2), { mode: 0o600 });
        renameSync(tmp, this.#path);
    }
}

/* ONE SMALL JSON VALUE in a file (the order of the list, the name of this
   Clavarium), written the same way. Without a path, kept in memory. */
export class JsonFile {
    #path; #value;
    constructor(path, fallback) {
        this.#path = path;
        this.#value = fallback;
        if (!path) return;
        mkdirSync(dirname(path), { recursive: true });
        try { const read = JSON.parse(readFileSync(path, 'utf8')); if (read && typeof read === 'object') this.#value = read; } catch { /* none yet */ }
    }
    get() { return structuredClone(this.#value); }
    set(value) {
        this.#value = structuredClone(value);
        if (!this.#path) return;
        const tmp = `${this.#path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.#value, null, 2), { mode: 0o600 });
        renameSync(tmp, this.#path);
    }
}
