/* FEATURES (04-11): what this Clavarium can do, where each thing stands, and at most one next step
 * for each -- the one component shown at first start (Welcome), on the home page (a banner) and at
 * the top of Settings.
 *
 *   GET  /api/features                 {goals, capabilities, next, counts, home, welcome, sharing}
 *   POST /api/features/dismiss         {id}: that feature's suggestion hidden ("Not for me") until its
 *                                      cause changes; {id: 'home'}: the home banner hidden until a new
 *                                      suggestion is born; {restore: true}: every hidden one back
 *   POST /api/features/goals           {goals: [ids]}: what the owner wants; they order, never hide
 *   POST /api/features/sharing         {on}: anonymous usage information, the choice only (nothing is sent)
 *   POST /api/features/welcome         the welcome was seen: never shown again by itself
 *
 * The state of each feature is READ from the modules that hold it (dictation, voice, boxes, alerts,
 * Tether, mailboxes, MeshCentral, updates, sign-in, conversations); nothing is decided here that
 * they do not say. A suggestion is born from what is already there -- a secret, BY ITS NAME, never
 * its value -- and is never acted on here: the page calls the module's own endpoint (POST
 * /api/dictation, /api/meshcentral/enable...) when the owner taps it.
 *
 * ORDER = IMPACT. For each suggestion: goals x (value + opens) / effort, halved while a feature it
 * requires does not work. `goals` is 2 when it serves a goal chosen, else 1; `opens` counts the
 * features that require it (and what it opens outside the registry), only while it does not work;
 * `effort` is 1 for two clicks, 3 for an account or a program elsewhere, 4 for a device. A feature
 * that stopped working ("problem") comes before all, with its repair. Ties: the registry's order. */
import { PROVIDERS as DICTATION } from './voice.mjs';
import { ELEVEN_SECRET } from './speech.mjs';
import { Refusal } from './conversations.mjs';
import { JsonFile } from './store.mjs';

export const GOALS = ['home', 'dictate', 'mail', 'code', 'work', 'calm'];
export const STATUSES = ['off', 'partial', 'ready', 'problem'];
/* What it takes, in the owner's words, and its weight in the impact rule. */
export const EFFORTS = { '2 clicks': 1, 'account elsewhere': 3, 'on your computer': 3, 'a device': 4 };
/* A backup older than this is said as old, and suggested again. */
export const BACKUP_DAYS = 30;

/* A SECRET'S NAME -> a provider. A short table of the known ones first; then the catalogue of
   models (models.dev, catalog.mjs), where each provider says the names it reads. */
const KNOWN = [
    [/^OVH(CLOUD)?_[A-Z0-9_]*KEY[A-Z0-9_]*$|^OVH_AI_ENDPOINTS_[A-Z0-9_]+$/, 'ovh'],
    [/^MISTRAL_[A-Z0-9_]+$/, 'mistral'],
    [/^GROQ_[A-Z0-9_]+$/, 'groq'],
    [/^OPENAI_[A-Z0-9_]+$/, 'openai'],
    [/^ANTHROPIC_[A-Z0-9_]+$/, 'anthropic'],
    [/^ELEVENLABS_[A-Z0-9_]+$/, 'elevenlabs'],
];
/* The catalogue's ids for the providers of the table. */
const CATALOGUE_ID = { ovh: 'ovhcloud' };
const LABEL = { ovh: 'OVH', mistral: 'Mistral', groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic', elevenlabs: 'ElevenLabs' };
export function providerOf(name, catalogue = []) {
    const n = String(name ?? '');
    for (const [shape, id] of KNOWN) if (shape.test(n)) return id;
    const found = (Array.isArray(catalogue) ? catalogue : []).find((p) => Array.isArray(p?.env) && p.env.includes(n));
    if (!found) return null;
    const back = Object.entries(CATALOGUE_ID).find(([, c]) => c === found.id);
    return back ? back[0] : String(found.id);
}
/* The usable secrets (not expired), each with its provider: the raw matter of suggestions. */
export function keysOf(secrets = [], catalogue = []) {
    return secrets.filter((s) => s && typeof s.name === 'string' && !s.expired && !s.ephemeral)
        .map((s) => ({ name: s.name, provider: providerOf(s.name, catalogue) })).filter((k) => k.provider);
}

/* Dictation: the providers voice.mjs offers, the best first; the models said by a word. */
const DICTATION_ORDER = ['ovh', 'mistral', 'groq', 'openai'];
const DICTATION_MODELS = {
    ovh: [{ id: 'whisper-large-v3-turbo', word: 'fast' }, { id: 'whisper-large-v3', word: 'accurate' }],
};
/* OpenCode: its provider in the catalogue and a model to start with (the page keeps it only if the catalogue has it). */
const OPENCODE_MODEL = { ovh: 'gpt-oss-120b' };
const OPENCODE_ORDER = ['ovh', 'mistral', 'anthropic', 'openai', 'groq'];

const works = (status) => status === 'ready' || status === 'partial';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/* `say`: the key of its words for the page (FEATURE_WORDS_FR), with what fills them. */
const sug = ({ key, ...s }) => ({ say: { key: key ?? `features-sug-${s.id.replace(':', '-')}`, vars: s.vars ?? {} }, cause: '', ...s });

/* THE REGISTRY. Ids are stable: they will be written in files (workflows). `v`: what it brings alone
   (1-3); `plus`: what it opens outside the registry; `effort`: what setting it up takes, when no suggestion says less; `requires`: features that must work first;
   `configure`: what to set and where -- in Clavarium, or outside it; `chapter`: its chapter of Settings. */
export const REGISTRY = [
    { id: 'dictation', effort: 'account elsewhere', name: 'Dictation', benefit: 'Talk instead of typing', goals: ['dictate', 'home', 'code', 'work'], v: 3, plus: 1, chapter: 's-dictation',
        configure: { where: 'inside', what: 'Dictation settings: a speech-to-text engine and its key' },
        state(ctx) {
            const d = ctx.dictation ?? {};
            if (d.on && (d.secretExpired || d.secretMissing)) return { status: 'problem', word: d.secretExpired ? 'Key expired' : 'Key missing', repair: { label: 'Replace the key', action: 'settings', chapter: 's-dictation' } };
            if (d.on) return { status: 'ready', word: (d.provider && DICTATION[d.provider]?.label) || 'On' };
            if (d.source === 'env') return { status: 'ready', word: 'Set on the server' };
            const key = DICTATION_ORDER.map((p) => ctx.keys.find((k) => k.provider === p)).find(Boolean);
            if (key) {
                const p = DICTATION[key.provider]; const label = LABEL[key.provider];
                return { status: 'off', suggestion: sug({ id: `dictation:${key.provider}`, key: 'features-sug-dictation', label: `Turn on dictation with ${label}`, vars: { provider: label }, action: 'dictation', effort: '2 clicks', provider: key.provider, url: p.url,
                    model: p.model, models: DICTATION_MODELS[key.provider] ?? [{ id: p.model, word: '' }], secret: key.name, cause: key.name }) };
            }
            return { status: 'off', suggestion: sug({ id: 'dictation:key', label: 'Add a speech-to-text key', action: 'settings', chapter: 's-dictation', effort: 'account elsewhere' }) };
        } },
    { id: 'boxes', effort: 'a device', name: 'Voice boxes', benefit: 'Talk to it from any room', goals: ['home'], v: 3, requires: ['dictation'], chapter: 'boxes',
        configure: { where: 'outside', what: 'A voice box device, plugged in and paired' },
        state(ctx) {
            const all = ctx.boxes ?? [];
            if (!all.length) return { status: 'off', suggestion: sug({ id: 'boxes:add', label: 'Add a voice box', action: 'boxes', effort: 'a device' }) };
            const on = all.filter((b) => b.online).length;
            if (!on) return { status: 'problem', word: 'Offline', repair: { label: 'See the boxes', action: 'boxes' } };
            return { status: on === all.length ? 'ready' : 'partial', word: `${on} of ${all.length} online` };
        } },
    { id: 'speech', effort: 'account elsewhere', name: 'Voice', benefit: 'It answers out loud', goals: ['home'], v: 1, chapter: 's-dictation',
        configure: { where: 'inside', what: 'A voice on this server; a key for a more natural one' },
        state(ctx) {
            if (ctx.secrets.some((s) => s.name === ELEVEN_SECRET && !s.expired)) return { status: 'ready', word: 'ElevenLabs' };
            return { status: 'ready', word: 'On this server', suggestion: sug({ id: 'speech:elevenlabs', label: 'A more natural voice', action: 'secret', secret: ELEVEN_SECRET, effort: 'account elsewhere' }) };
        } },
    { id: 'alerts', effort: '2 clicks', name: 'Alerts', benefit: 'Know when the AI waits for you', goals: ['code', 'dictate', 'work'], v: 2, chapter: 's-alerts',
        configure: { where: 'inside', what: 'Alerts, allowed on each device' },
        state(ctx) {
            const n = Number(ctx.alerts) || 0;
            if (n > 0) return { status: 'ready', word: plural(n, 'device') };
            return { status: 'off', suggestion: sug({ id: 'alerts:here', label: 'Turn on alerts here', action: 'alerts', effort: '2 clicks' }) };
        } },
    { id: 'opencode', effort: 'account elsewhere', name: 'OpenCode', benefit: 'A second AI, with your own key', goals: ['code', 'mail', 'work'], v: 2, chapter: 'new',
        configure: { where: 'inside', what: 'A conversation, its provider and its key' },
        state(ctx) {
            const n = ctx.conversations.filter((c) => c.tool === 'opencode').length;
            if (n > 0) return { status: 'ready', word: plural(n, 'conversation') };
            if (!ctx.tools.includes('opencode')) return { status: 'off', word: 'Not offered here' };
            const key = OPENCODE_ORDER.map((p) => ctx.keys.find((k) => k.provider === p)).find(Boolean);
            if (key) return { status: 'off', suggestion: sug({ id: `opencode:${key.provider}`, key: 'features-sug-opencode', label: `Start an OpenCode conversation with ${LABEL[key.provider] ?? key.provider}`, vars: { provider: LABEL[key.provider] ?? key.provider }, action: 'opencode', effort: '2 clicks',
                provider: CATALOGUE_ID[key.provider] ?? key.provider, ...(OPENCODE_MODEL[key.provider] ? { model: OPENCODE_MODEL[key.provider] } : {}), secret: key.name, cause: key.name }) };
            return { status: 'off', suggestion: sug({ id: 'opencode:key', label: 'Start an OpenCode conversation', action: 'opencode', effort: 'account elsewhere' }) };
        } },
    { id: 'answerer', effort: 'on your computer', name: 'Answers while away', benefit: 'The AI keeps going without you', goals: ['code', 'work'], v: 2, chapter: 'answerer',
        configure: { where: 'outside', what: 'Models of two makers, set on the server' },
        state(ctx) {
            const n = Number(ctx.answerer) || 0;
            if (n >= 2) return { status: 'ready', word: plural(n, 'model') };
            if (n === 1) return { status: 'partial', word: '1 model' };
            return { status: 'off' };
        } },
    { id: 'mail', effort: 'on your computer', name: 'Mail & calendar', benefit: 'The AI keeps your diary', goals: ['mail', 'home', 'work'], v: 3, plus: 1, chapter: 'access',
        configure: { where: 'outside', what: 'A mailbox, or a calendar through Tether on your computer' },
        state(ctx) {
            const boxes = ctx.mail?.mailboxes ?? []; const targets = ctx.mail?.targets ?? [];
            const n = boxes.length + targets.length;
            if (!n) return { status: 'off', suggestion: sug({ id: 'mail:connect', label: 'Connect mail & calendar', action: 'mail', effort: 'on your computer' }) };
            if (boxes.length && boxes.every((b) => b.failure) && !targets.length) return { status: 'problem', word: 'Cannot be read', repair: { label: 'See the mailboxes', action: 'mail' } };
            return { status: 'ready', word: plural(n, 'account') };
        } },
    { id: 'screen', effort: '2 clicks', name: 'Remote screen', benefit: 'See your server from afar', goals: ['calm', 'code'], v: 1, chapter: 's-remote-screen',
        configure: { where: 'inside', what: 'The remote screen, turned on here' },
        state(ctx) {
            const s = ctx.screen;
            if (!s) return { status: 'off', word: 'Not offered here' };
            if (s.running) return { status: 'ready', word: 'On' };
            if (s.installed) return { status: 'problem', word: 'Not responding', repair: { label: 'Restart', action: 'screen' } };
            return { status: 'off', suggestion: sug({ id: 'screen:on', label: 'Turn on the remote screen', action: 'screen', effort: '2 clicks' }) };
        } },
    { id: 'backup', effort: '2 clicks', name: 'Backup', benefit: 'Never lose a thing', goals: ['calm', 'work'], v: 3, plus: 1, chapter: 's-backup',
        configure: { where: 'inside', what: 'An export of the setup, kept on your computer' },
        state(ctx) {
            const at = Date.parse(ctx.backupAt ?? '');
            const make = sug({ id: 'backup:export', label: 'Make a backup', action: 'backup', effort: '2 clicks' });
            if (!Number.isFinite(at)) return { status: 'off', word: 'Never done', suggestion: make };
            const days = Math.floor((ctx.now - at) / 86_400_000);
            if (days > BACKUP_DAYS) return { status: 'partial', word: `${days} days ago`, suggestion: { ...make, cause: String(Math.floor(days / BACKUP_DAYS)) } };
            return { status: 'ready', word: days < 1 ? 'Today' : plural(days, 'day') + ' ago' };
        } },
    { id: 'signin', effort: '2 clicks', name: 'Sign-in', benefit: 'Only who you choose gets in', goals: ['calm', 'work'], v: 1, chapter: 's-operators',
        configure: { where: 'inside', what: 'Who may sign in' },
        state(ctx) {
            if (ctx.team === null || ctx.team === undefined) return { status: 'ready', word: 'This machine only' };
            return { status: 'ready', word: ctx.team === 1 ? 'Just you' : plural(ctx.team, 'person', 'people') };
        } },
    { id: 'updates', effort: '2 clicks', name: 'Updates', benefit: 'Up to date, no effort', goals: ['calm'], v: 1, chapter: 's-updates',
        configure: { where: 'inside', what: 'Updates: when and how' },
        state(ctx) {
            const u = ctx.updates;
            if (!u?.installed) return { status: 'off', word: 'Not offered here' };
            if (u.mode === 'auto' || u.mode === 'asap') return { status: 'ready', word: 'Automatic' };
            return { status: 'partial', word: u.mode === 'off' ? 'Off' : 'When asked', suggestion: sug({ id: 'updates:auto', label: 'Make updates automatic', action: 'updates', effort: '2 clicks', channel: u.channel, window: u.window }) };
        } },
];

const hiddenHas = (prefs, s) => (prefs.hidden ?? []).some((h) => h.id === s.id && (h.cause ?? '') === (s.cause ?? ''));

/* The whole answer, from what the modules said (`ctx`) and what the owner chose (`prefs`). Pure. */
export function features(ctx0 = {}, prefs = {}) {
    const ctx = { secrets: [], conversations: [], tools: [], now: Date.now(), ...ctx0 };
    ctx.keys = keysOf(ctx.secrets, ctx.catalogue);
    const goals = (prefs.goals ?? []).filter((g) => GOALS.includes(g));
    const rows = REGISTRY.map((r, rank) => {
        let s;
        try { s = r.state(ctx) ?? {}; } catch { s = { status: 'off' }; }
        const status = STATUSES.includes(s.status) ? s.status : 'off';
        const suggestion = s.suggestion && status !== 'problem' ? s.suggestion : null;
        const dismissed = Boolean(suggestion && hiddenHas(prefs, suggestion));
        return { r, rank, status, word: s.word ?? '', suggestion: dismissed ? null : suggestion, dismissed, repair: status === 'problem' ? s.repair ?? null : null };
    });
    const byId = new Map(rows.map((x) => [x.r.id, x]));
    const unlocks = (id) => REGISTRY.filter((x) => (x.requires ?? []).includes(id)).map((x) => x.id);
    const blocked = (x) => (x.r.requires ?? []).filter((id) => !works(byId.get(id)?.status));
    const impact = (x) => {
        if (!x.suggestion || x.status === 'problem') return 0;
        const g = goals.length && x.r.goals.some((y) => goals.includes(y)) ? 2 : 1;
        const opens = works(x.status) ? 0 : unlocks(x.r.id).length + (x.r.plus ?? 0);
        return (g * (x.r.v + opens)) / EFFORTS[x.suggestion.effort] * (blocked(x).length ? 0.5 : 1);
    };
    for (const x of rows) x.impact = impact(x);
    const group = (x) => (x.status === 'problem' ? 0 : x.suggestion ? 1 : x.status === 'off' ? 2 : 3);
    rows.sort((a, b) => group(a) - group(b) || b.impact - a.impact || a.rank - b.rank);
    const capabilities = rows.map((x) => ({
        id: x.r.id, name: x.r.name, benefit: x.r.benefit, status: x.status, word: x.word, goals: x.r.goals,
        effort: x.suggestion?.effort ?? x.r.effort,
        unlocks: unlocks(x.r.id), requires: x.r.requires ?? [], blockedBy: blocked(x),
        configure: x.r.configure, chapter: x.r.chapter,
        ...(x.suggestion ? { suggestion: x.suggestion } : {}), ...(x.dismissed ? { dismissed: true } : {}), ...(x.repair ? { repair: x.repair } : {}),
    }));
    const next = capabilities.find((c) => c.suggestion && !c.blockedBy.length && c.status !== 'problem') ?? null;
    const doable = capabilities.filter((c) => c.suggestion && !c.blockedBy.length && EFFORTS[c.suggestion.effort] <= 2);
    const live = capabilities.filter((c) => c.suggestion).map((c) => c.suggestion.id);
    const home = prefs.home ?? {};
    const homeShown = (!home.hiddenAt || live.some((id) => !(home.seen ?? []).includes(id))) && (doable.length > 0 || capabilities.some((c) => c.status === 'problem'));
    return {
        goals, capabilities, next: next ? next.id : null,
        counts: { ready: capabilities.filter((c) => works(c.status)).length, total: capabilities.length, doable: doable.length, problems: capabilities.filter((c) => c.status === 'problem').length, hidden: (prefs.hidden ?? []).length },
        home: { show: homeShown },
        welcome: ctx.conversations.length === 0 && prefs.welcomeDone !== true,
        sharing: { on: prefs.sharing !== false, sends: false },
    };
}

/* A slow look (a host command) kept a while: the page asks often. */
export function cached(read, ms = 60_000, now = () => Date.now()) {
    let at = -Infinity; let value; let pending = null;
    return async () => {
        if (now() - at < ms) return value;
        pending ??= Promise.resolve().then(read).then((v) => { value = v; at = now(); return v; }, () => value).finally(() => { pending = null; });
        return pending;
    };
}

export class Features {
    #file; #context; #now;
    /* `context()`: what the modules say now (see `features`); `file`: the owner's choices. */
    constructor({ file = new JsonFile(undefined, {}), context = async () => ({}), now = () => Date.now() } = {}) {
        this.#file = file; this.#context = context; this.#now = now;
    }
    #prefs() { const p = this.#file.get(); return p && typeof p === 'object' ? p : {}; }
    #put(change) { this.#file.set({ ...this.#prefs(), ...change }); }
    async about() {
        const p = this.#prefs();
        const ctx = await this.#context();
        return features({ ...ctx, backupAt: p.backupAt, now: this.#now() }, p);
    }
    async dismiss({ id, restore } = {}) {
        if (restore === true) { this.#put({ hidden: [] }); return this.about(); }
        const all = await this.about();
        if (id === 'home') {
            this.#put({ home: { hiddenAt: new Date(this.#now()).toISOString(), seen: all.capabilities.filter((c) => c.suggestion).map((c) => c.suggestion.id) } });
            return this.about();
        }
        const c = all.capabilities.find((x) => x.id === id);
        if (!c) throw new Refusal(404, 'No such feature.');
        if (!c.suggestion) return all;
        const hidden = (this.#prefs().hidden ?? []).filter((h) => h.id !== c.suggestion.id).concat({ id: c.suggestion.id, cause: c.suggestion.cause ?? '' }).slice(-100);
        this.#put({ hidden });
        return this.about();
    }
    async setGoals(goals) {
        if (!Array.isArray(goals) || goals.some((g) => !GOALS.includes(g))) throw new Refusal(400, `Goals are among: ${GOALS.join(', ')}.`);
        this.#put({ goals: [...new Set(goals)] });
        return this.about();
    }
    /* The choice only: nothing is sent yet (the relay comes later). */
    setSharing(on) {
        if (typeof on !== 'boolean') throw new Refusal(400, 'Say on: true or false.');
        this.#put({ sharing: on });
        return { on, sends: false };
    }
    welcomeDone() { this.#put({ welcomeDone: true }); return this.about(); }
    /* A setup exported (Settings, Backup, or a step here): the backup's day. */
    exported() { this.#put({ backupAt: new Date(this.#now()).toISOString() }); }
}

export async function handleFeatures(request, response, features, originOk, headers = {}) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    const send = (status, body) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body)); return true; };
    try {
        if (request.method === 'GET' && pathname === '/api/features') return send(200, await features.about());
        if (request.method !== 'POST' || !/^\/api\/features\/(dismiss|goals|sharing|welcome)$/.test(pathname)) return false;
        if (!originOk(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) return send(403, { error: 'This request does not come from this site.' });
        let text = '';
        for await (const piece of request) { text += piece; if (text.length > 4096) return send(413, { error: 'Too long.' }); }
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { return send(400, { error: 'The request is not JSON.' }); }
        if (!body || typeof body !== 'object') body = {};
        if (pathname === '/api/features/dismiss') return send(200, await features.dismiss({ id: String(body.id ?? ''), restore: body.restore === true }));
        if (pathname === '/api/features/goals') return send(200, await features.setGoals(body.goals));
        if (pathname === '/api/features/sharing') return send(200, features.setSharing(body.on));
        return send(200, await features.welcomeDone());
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message });
        return send(500, { error: 'Something failed on the server.' });
    }
}

/* THE WORDS of this component in French; English is in the page (web/features.js) and in the
   registry above. Served with the chat screen's words (/api/talk/words, talk.mjs), so the page
   reads them as all its others, and the owner's own words may replace any of them. */
export const FEATURE_WORDS_FR = {
    'features-title': 'Fonctions',
    'features-lit-of': '{n} pièces allumées sur {t}',
    'features-f0': 'La maison s\'éveille.', 'features-f1': 'Elle prend vie.', 'features-f2': 'Presque tout est allumé.', 'features-f3': 'Tout brille.',
    'features-hello': 'Bienvenue chez toi.',
    'features-hello-p': 'Tes assistants vivent ici. Choisis ce que tu veux : les bonnes pièces s\'allument.',
    'features-want-q': 'Que veux-tu faire ?', 'features-want-hint': 'Un ou plusieurs. Modifiable plus tard.',
    'features-continue': 'Continuer', 'features-skip': 'Passer', 'features-back': 'Retour',
    'features-import-t': 'Déjà une configuration ? Importer un fichier', 'features-import-h': 'Reprendre les réglages d\'une autre installation',
    'features-share-t': 'Aider à améliorer Clavarium en partageant des informations d\'usage anonymes',
    'features-share-see': 'Voir ce qui part', 'features-share-note': 'Des compteurs seulement, jamais de nom. Rien n\'est envoyé pour l\'instant : seul ton choix est gardé.',
    'features-create-conv': 'Créer une conversation',
    'features-lg-on': 'Prête', 'features-lg-next': 'Prochaine étape', 'features-lg-later': 'Plus tard',
    'features-your-next': 'Ta prochaine étape', 'features-back-next': '✦ Revenir à ta prochaine étape',
    'features-unlocks': 'Débloque aussi', 'features-other-steps': 'Autres étapes', 'features-n-more': 'Encore {n} étapes', 'features-fewer': 'Moins',
    'features-not-for-me': 'Pas pour moi', 'features-hidden': 'Masquée.', 'features-testing': 'Essai…', 'features-ready': 'Prête', 'features-not-yet': 'Pas encore',
    'features-after': 'Après : {x}', 'features-details': 'Détail dans Réglages', 'features-configure-in': 'À régler ici', 'features-configure-out': 'À régler ailleurs',
    'features-paste-key': 'Colle la clé', 'features-keep': 'Garder', 'features-cancel': 'Annuler', 'features-key-saved': 'Clé gardée',
    'features-model': 'Modèle', 'features-and-more': 'et {n} autres', 'features-banner-hidden': 'Suggestions masquées jusqu\'à du nouveau.',
    'features-your-goals': 'Tes buts', 'features-show-hidden': 'Revoir les suggestions masquées ({n})', 'features-unlocked': 'Débloquée !',
    'features-house': 'Plan de tes fonctions en maison', 'features-all-done': 'Plus rien à régler. Profite.',
    'features-repair-t': '{x} : {w}', 'features-failed': 'Pas fait : {e}', 'features-done': '{x} : fait',
    'features-fast': 'rapide', 'features-accurate': 'précis',
    'features-e-2-clicks': '2 clics', 'features-e-account-elsewhere': '1 compte ailleurs', 'features-e-on-your-computer': 'Sur ton ordinateur', 'features-e-a-device': 'Un appareil',
    'features-g-home': 'Parler à la maison', 'features-g-dictate': 'Dicter', 'features-g-mail': 'Mails et agenda', 'features-g-code': 'Coder', 'features-g-work': 'Travailler', 'features-g-calm': 'Être tranquille',
    'features-dictation-name': 'Dictée', 'features-dictation-short': 'Dictée', 'features-dictation-benefit': 'Parle-lui au lieu de taper',
    'features-boxes-name': 'Boîtiers vocaux', 'features-boxes-short': 'Boîtiers', 'features-boxes-benefit': 'Parle-lui depuis chaque pièce',
    'features-speech-name': 'Voix', 'features-speech-short': 'Voix', 'features-speech-benefit': 'Elle te répond à voix haute',
    'features-alerts-name': 'Alertes', 'features-alerts-short': 'Alertes', 'features-alerts-benefit': 'Prévenu quand l\'IA t\'attend',
    'features-opencode-name': 'OpenCode', 'features-opencode-short': 'OpenCode', 'features-opencode-benefit': 'Une 2ᵉ IA, avec ta propre clé',
    'features-answerer-name': 'Réponses en ton absence', 'features-answerer-short': 'Absence', 'features-answerer-benefit': 'L\'IA avance sans toi',
    'features-mail-name': 'Mails et agenda', 'features-mail-short': 'Mails', 'features-mail-benefit': 'L\'IA tient ton agenda',
    'features-screen-name': 'Écran à distance', 'features-screen-short': 'Écran', 'features-screen-benefit': 'Ton serveur, vu de loin',
    'features-backup-name': 'Sauvegarde', 'features-backup-short': 'Sauvegarde', 'features-backup-benefit': 'Ne perds jamais rien',
    'features-signin-name': 'Connexion', 'features-signin-short': 'Connexion', 'features-signin-benefit': 'Seuls ceux que tu choisis entrent',
    'features-updates-name': 'Mises à jour', 'features-updates-short': 'Mises à jour', 'features-updates-benefit': 'À jour sans y penser',
    'features-sug-dictation': 'Activer la dictée avec {provider}', 'features-sug-dictation-key': 'Ajouter une clé de dictée',
    'features-sug-boxes-add': 'Ajouter un boîtier vocal', 'features-sug-speech-elevenlabs': 'Une voix plus naturelle', 'features-sug-alerts-here': 'Activer les alertes ici',
    'features-sug-opencode': 'Créer une conversation OpenCode avec {provider}', 'features-sug-opencode-key': 'Créer une conversation OpenCode',
    'features-sug-mail-connect': 'Relier mails et agenda', 'features-sug-screen-on': 'Activer l\'écran à distance', 'features-sug-backup-export': 'Faire une sauvegarde',
    'features-sug-updates-auto': 'Rendre les mises à jour automatiques',
    'features-btn-dictation': 'Activer', 'features-btn-alerts': 'Activer', 'features-btn-screen': 'Activer', 'features-btn-updates': 'Automatiques', 'features-btn-backup': 'Exporter',
    'features-btn-opencode': 'Créer…', 'features-btn-secret': '+ Clé…', 'features-btn-boxes': 'Ajouter…', 'features-btn-mail': 'Connecter…', 'features-btn-settings': 'Régler…',
    'features-w-Key expired': 'Clé expirée', 'features-w-Key missing': 'Clé absente', 'features-w-Set on the server': 'Réglée sur le serveur', 'features-w-On': 'Active',
    'features-w-Offline': 'Hors ligne', 'features-w-On this server': 'Sur ce serveur', 'features-w-Not offered here': 'Pas proposé ici', 'features-w-Never done': 'Jamais faite',
    'features-w-Today': 'Aujourd\'hui', 'features-w-This machine only': 'Cette machine seulement', 'features-w-Just you': 'Toi seul', 'features-w-Automatic': 'Automatiques',
    'features-w-Off': 'Désactivées', 'features-w-When asked': 'À la demande', 'features-w-Not responding': 'Ne répond plus', 'features-w-Cannot be read': 'Illisible',
    'features-w-{n} model': '{n} modèle', 'features-w-{n} models': '{n} modèles', 'features-w-{n} device': '{n} appareil', 'features-w-{n} devices': '{n} appareils',
    'features-w-{n} conversation': '{n} conversation', 'features-w-{n} conversations': '{n} conversations', 'features-w-{n} account': '{n} compte', 'features-w-{n} accounts': '{n} comptes',
    'features-w-{n} people': '{n} personnes', 'features-w-{n} of {m} online': '{n} sur {m} en ligne', 'features-w-{n} day ago': 'Il y a {n} jour', 'features-w-{n} days ago': 'Il y a {n} jours',
    'features-w-OVH AI Endpoints': 'OVH AI Endpoints', 'features-w-ElevenLabs': 'ElevenLabs',
    'features-cfg-dictation': 'Réglages de la dictée : un moteur de reconnaissance et sa clé', 'features-cfg-boxes': 'Un boîtier vocal, branché et appairé',
    'features-cfg-speech': 'Une voix sur ce serveur ; une clé pour une plus naturelle', 'features-cfg-alerts': 'Les alertes, permises sur chaque appareil',
    'features-cfg-opencode': 'Une conversation, son fournisseur et sa clé', 'features-cfg-answerer': 'Des modèles de deux fabricants, réglés sur le serveur',
    'features-cfg-mail': 'Une boîte mail, ou un agenda par Tether sur ton ordinateur', 'features-cfg-screen': 'L\'écran à distance, activé ici',
    'features-cfg-backup': 'Un export de la configuration, gardé sur ton ordinateur', 'features-cfg-signin': 'Qui peut se connecter', 'features-cfg-updates': 'Les mises à jour : quand et comment',
    'features-r-Replace the key': 'Remplacer la clé', 'features-r-See the boxes': 'Voir les boîtiers', 'features-r-Restart': 'Relancer', 'features-r-See the mailboxes': 'Voir les boîtes mail',
};
/* The words for a language: French for 'fr', none otherwise (the page's English stays). */
export const featureWords = (lang) => (String(lang ?? '').toLowerCase().split('-')[0] === 'fr' ? { ...FEATURE_WORDS_FR } : {});
