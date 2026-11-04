/* THE DICTATION ENGINES ON OFFER, in one place: the providers, their speech-to-text models, and which kept
 * secrets look like a key for each. Settings > Dictation uses it; so may anything that sets dictation up
 * (an "integration"): `catalogue()` and `suggestions()` say what could be chosen, never a key's value.
 *
 * MODELS: a known base list per provider, with a short label. Once a key is chosen, the provider's own
 * listing (GET <base>/models, the OpenAI-compatible one; OVH AI Endpoints has it too) is read with that key,
 * kept to its speech-to-text models, and kept 24 h. Any failure: the base list, silently. */

export const PROVIDERS = {
    ovh: { label: 'OVH AI Endpoints', short: 'OVH', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions', model: 'whisper-large-v3-turbo',
        models: [{ id: 'whisper-large-v3-turbo', label: 'fast' }, { id: 'whisper-large-v3', label: 'more accurate' }] },
    openai: { label: 'OpenAI', short: 'OpenAI', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1',
        models: [{ id: 'whisper-1', label: 'fast' }, { id: 'gpt-4o-mini-transcribe', label: 'fast' }, { id: 'gpt-4o-transcribe', label: 'more accurate' }] },
    groq: { label: 'Groq', short: 'Groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo',
        models: [{ id: 'whisper-large-v3-turbo', label: 'fast' }, { id: 'whisper-large-v3', label: 'more accurate' }] },
    mistral: { label: 'Mistral', short: 'Mistral', url: 'https://api.mistral.ai/v1/audio/transcriptions', model: 'voxtral-mini-latest',
        models: [{ id: 'voxtral-mini-latest', label: 'fast' }, { id: 'voxtral-small-latest', label: 'more accurate' }] },
    other: { label: 'Other (compatible)', url: '', model: '', models: [] },
};

/* A secret's name that reads as a key of this provider. */
export const KEY_NAMES = { ovh: /^OVH_AI_ENDPOINTS/, mistral: /^MISTRAL/, groq: /^GROQ/, openai: /^OPENAI/ };
/* The order a suggestion is made in: the first provider with a key. */
const ORDER = ['ovh', 'mistral', 'groq', 'openai'];

/* A speech-to-text model, by its name: never a voice (tts), nor a live stream one (realtime). */
export const isSpeechToText = (id) => /whisper|voxtral|transcribe|speech-to-text/i.test(id) && !/tts|realtime/i.test(id);
export const MODELS_TTL_MS = 24 * 3600_000;

export function keysFor(provider, names) {
    const re = KEY_NAMES[provider];
    return re ? names.filter((n) => re.test(n)) : [];
}
/* The name offered for a new key: MISTRAL_DICTATION_KEY, then _2... when taken. */
export function newKeyName(provider, names = []) {
    const base = `${provider === 'ovh' ? 'OVH_AI_ENDPOINTS' : String(provider).toUpperCase()}_DICTATION_KEY`;
    if (!names.includes(base)) return base;
    for (let i = 2; ; i++) if (!names.includes(`${base}_${i}`)) return `${base}_${i}`;
}

export class Engines {
    #fetcher; #now; #cache = new Map();
    constructor({ fetcher = fetch, now = Date.now } = {}) { this.#fetcher = fetcher; this.#now = now; }
    static base(provider) { return (PROVIDERS[provider]?.models ?? []).map((m) => ({ ...m })); }
    /* The models of `provider`, read with `key` (a value, opened by the caller) when there is one. */
    async models(provider, key, cacheKey = provider) {
        const p = PROVIDERS[provider];
        if (!p || !p.url) return [];
        if (!key) return Engines.base(provider);
        const kept = this.#cache.get(cacheKey);
        if (kept && this.#now() - kept.at < MODELS_TTL_MS) return kept.models.map((m) => ({ ...m }));
        let models;
        try {
            const r = await this.#fetcher(p.url.replace(/\/audio\/transcriptions\/?$/, '/models'), { redirect: 'error', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
            if (!r.ok) throw new Error(String(r.status));
            const body = await r.json();
            const ids = [...new Set((Array.isArray(body?.data) ? body.data : []).map((m) => String(m?.id ?? '')).filter(isSpeechToText))];
            const known = new Map(p.models.map((m) => [m.id, m.label]));
            /* The known ones first, in their order; then the provider's others. */
            models = [...p.models.filter((m) => ids.includes(m.id)), ...ids.filter((id) => !known.has(id)).sort().map((id) => ({ id, label: '' }))];
            if (models.length === 0) throw new Error('none');
        } catch { return Engines.base(provider); }   /* not kept: tried again next time */
        this.#cache.set(cacheKey, { at: this.#now(), models });
        return models.map((m) => ({ ...m }));
    }
    /* Every provider, its models (read with the first key that looks like its own) and those keys. */
    async catalogue(names, reveal = () => undefined) {
        return Promise.all(Object.entries(PROVIDERS).map(async ([id, p]) => {
            const keys = keysFor(id, names);
            const models = await this.models(id, keys[0] ? reveal(keys[0]) : undefined, `${id} ${keys[0] ?? ''}`);
            return { id, label: p.label, url: p.url, model: p.model, models, keys };
        }));
    }
    /* For the slots not set yet ("main", "backup"): a provider with a key, its first model. The backup is
       another provider than the main's. */
    async suggestions({ main, backup }, names, reveal) {
        const all = await this.catalogue(names, reveal);
        const usable = ORDER.map((id) => all.find((p) => p.id === id)).filter((p) => p.keys.length > 0);
        const out = [];
        let mainProvider = main?.provider;
        if (!main) {
            const p = usable[0];
            if (p) { out.push({ slot: 'main', provider: p.id, model: p.models[0]?.id ?? p.model, secret: p.keys[0] }); mainProvider = p.id; }
        }
        if (!backup) {
            const p = usable.find((x) => x.id !== mainProvider);
            if (p) out.push({ slot: 'backup', provider: p.id, model: p.models[0]?.id ?? p.model, secret: p.keys[0] });
        }
        return out;
    }
}
