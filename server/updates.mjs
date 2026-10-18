/* UPDATES, AS SETTINGS SHOWS THEM: what runs, what is out, how this server
 * updates itself, what happened. The updater itself runs as root
 * (deploy/updater.mjs); this server only READS what it writes (state.json,
 * update.conf: both readable by all, written by root) and ASKS through the
 * host program, whose verbs check every word again:
 *
 *   update check                  ask the registry now (waits for the answer)
 *   update set mode|channel|window <value>
 *   update apply <version>        update to the version that is out (in the background)
 *   update rollback <version>     go back to a release that is kept (in the background)
 *
 * A failed update is told to the owner once: an alert on the devices that
 * asked for alerts (alerts.mjs), and the line in Settings.
 */
import { readFileSync, existsSync } from 'node:fs';
import { Refusal } from './conversations.mjs';

export const STATE_FILE = '/var/lib/clavarium/update/state.json';
export const CONF_FILE = '/etc/clavarium/update.conf';
export const MODES = ['auto', 'asap', 'ask', 'off'];
export const CHANNELS = ['latest', 'next'];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/;
const LOCAL = /^local-\d{8}-\d{6}$/;
const WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const HISTORY_SHOWN = 8;
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 300) ?? '';

export class Updates {
    #host; #state; #conf; #version; #store; #alerts; #timer;

    /* `host(argv)`: the host program. `store`: what was told already. */
    constructor({ host, version, stateFile = STATE_FILE, confFile = CONF_FILE, store, alerts }) {
        this.#host = host; this.#version = version; this.#state = stateFile; this.#conf = confFile; this.#store = store; this.#alerts = alerts;
    }

    /* Installed by install.sh: the updater has its settings. A server run from a working tree has none. */
    get installed() { return existsSync(this.#conf); }

    #read() { try { return JSON.parse(readFileSync(this.#state, 'utf8')); } catch { return {}; } }
    #settings() {
        const conf = { MODE: 'auto', CHANNEL: 'latest', WINDOW: '02:00-05:00' };
        try { for (const line of readFileSync(this.#conf, 'utf8').split('\n')) { const m = /^([A-Z]+)=(.*)$/.exec(line.trim()); if (m) conf[m[1]] = m[2]; } } catch { /* none */ }
        return { mode: MODES.includes(conf.MODE) ? conf.MODE : 'auto', channel: CHANNELS.includes(conf.CHANNEL) ? conf.CHANNEL : 'latest', window: WINDOW.test(conf.WINDOW) ? conf.WINDOW : '02:00-05:00' };
    }

    about() {
        if (!this.installed) return { installed: false, version: this.#version };
        const s = this.#read();
        const releases = Array.isArray(s.releases) ? s.releases : [];
        return {
            installed: true,
            version: s.version ?? this.#version,
            ...this.#settings(),
            available: VERSION.test(s.available ?? '') ? s.available : null,
            checkedAt: s.checkedAt ?? null,
            checkError: s.checkError ?? null,
            running: s.running ?? null,
            refused: s.refused ?? null,
            /* What can be gone back to: the kept releases that do not run. */
            back: releases.filter((r) => !r.current && (VERSION.test(r.id) || LOCAL.test(r.id))).map((r) => ({ id: r.id, version: r.version })),
            history: (Array.isArray(s.history) ? s.history : []).slice(0, HISTORY_SHOWN).map(({ at, action, from, to, result, why }) => ({ at, action, from, to, result, why: why ?? null })),
        };
    }

    async #ask(argv, what) {
        const r = await this.#host(['update', ...argv]);
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, `${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
    }
    #needInstalled() { if (!this.installed) throw new Refusal(409, 'This server was not installed with deploy/install.sh: it does not update itself.'); }

    async check() { this.#needInstalled(); await this.#ask(['check'], 'The registry could not be asked'); return this.about(); }

    async settings({ mode, channel, window } = {}) {
        this.#needInstalled();
        if (mode !== undefined && !MODES.includes(mode)) throw new Refusal(400, 'Not a mode.');
        if (channel !== undefined && !CHANNELS.includes(channel)) throw new Refusal(400, 'Not a channel.');
        if (window !== undefined && (!WINDOW.test(window) || window.slice(0, 5) === window.slice(6))) throw new Refusal(400, 'The window is two times, like 02:00-05:00, not the same.');
        for (const [key, value] of [['mode', mode], ['channel', channel], ['window', window]]) if (value !== undefined) await this.#ask(['set', key, value], 'Not saved');
        return this.about();
    }

    async apply(version) {
        this.#needInstalled();
        const a = this.about();
        if (!VERSION.test(version ?? '') || version !== a.available) throw new Refusal(409, 'This version is not the one that is out: check again.');
        if (a.running) throw new Refusal(409, 'An update is under way already.');
        await this.#ask(['apply', version], 'Not started');
        return this.about();
    }

    async back(id) {
        this.#needInstalled();
        const a = this.about();
        if (!a.back.some((r) => r.id === id)) throw new Refusal(409, 'This version is not kept here.');
        if (a.running) throw new Refusal(409, 'An update is under way already.');
        await this.#ask(['rollback', id], 'Not started');
        return this.about();
    }

    /* A FAILED UPDATE IS TOLD, once: looked at now and then (the updater may have just restarted this server). */
    watch(everyMs = 60_000) {
        const look = () => {
            if (!this.installed) return;
            const last = (this.#read().history ?? [])[0];
            if (!last || last.result === 'done' || !this.#store) return;
            const key = `${last.at}|${last.to}`;
            if (this.#store.get('told')?.key === key) return;
            this.#store.put({ name: 'told', key });
            const title = last.result === 'rolled-back' ? `The update to ${last.to} did not work: back on ${last.from}` : `${last.action === 'back' ? 'Going back to' : 'The update to'} ${last.to} failed`;
            void this.#alerts?.tell({ title, body: String(last.why ?? '').slice(0, 180), url: '/?open=settings' })?.catch?.(() => {});
        };
        look();
        this.#timer = setInterval(look, everyMs); this.#timer.unref?.();
        return () => clearInterval(this.#timer);
    }
}
