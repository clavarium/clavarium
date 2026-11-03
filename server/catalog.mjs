/* THE CATALOGUE OF MODELS (03-11): the providers and their models as OpenCode itself reads them -- models.dev,
 * a public catalogue, not its code -- for a conversation made with OpenCode to be set up from here: a provider,
 * one of its models, and the name of the key it reads. Read once a day at most; the last one kept for when
 * the catalogue cannot be reached. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CATALOGUE_URL = 'https://models.dev/api.json';
export const CATALOGUE_TTL_MS = 24 * 3600_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;

/* models.dev's own shape -> [{ id, name, env, models: [{ id, name }] }], providers by name, models by name. */
export function providersOf(raw) {
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw).flatMap(([id, p]) => {
        if (!ID.test(id) || !p || typeof p !== 'object') return [];
        const env = (Array.isArray(p.env) ? p.env : []).map(String).filter((e) => ENV.test(e)).slice(0, 4);
        const models = Object.entries(p.models ?? {}).flatMap(([mid, m]) => (ID.test(mid) ? [{ id: mid, name: String(m?.name ?? mid).slice(0, 80) }] : []))
            .sort((a, b) => a.name.localeCompare(b.name));
        return models.length ? [{ id, name: String(p.name ?? id).slice(0, 60), env, models }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export class Catalogue {
    #file; #fetch; #now; #got = null; #at = 0;
    constructor({ file, fetcher = fetch, now = () => Date.now() }) { this.#file = file; this.#fetch = fetcher; this.#now = now; }
    async providers() {
        if (this.#got && this.#now() - this.#at < CATALOGUE_TTL_MS) return this.#got;
        try {
            const r = await this.#fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
            if (!r.ok) throw new Error(String(r.status));
            const list = providersOf(await r.json());
            if (!list.length) throw new Error('empty');
            this.#got = list; this.#at = this.#now();
            try { mkdirSync(dirname(this.#file), { recursive: true }); writeFileSync(this.#file, JSON.stringify(list)); } catch { /* kept in memory */ }
        } catch {
            if (!this.#got) { try { this.#got = JSON.parse(readFileSync(this.#file, 'utf8')); } catch { this.#got = []; } }
        }
        return this.#got;
    }
}

/* What OpenCode reads in its work folder (opencode.json): the model chosen, its key read from the secret given. */
export function openCodeConfig({ provider, model, secret }) {
    if (!ID.test(String(provider ?? '')) || !ID.test(String(model ?? '')) || !ENV.test(String(secret ?? ''))) return null;
    return { $schema: 'https://opencode.ai/config.json', model: `${provider}/${model}`, provider: { [provider]: { options: { apiKey: `{env:${secret}}` } } } };
}
