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
 *
 * An update about to stop this server is told to every page (notice): a
 * header on each answer, read by app.js, which gives way to the maintenance
 * page (deploy/maintenance.html) until the new server answers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Refusal } from './conversations.mjs';
import { compareVersions, inWindow } from '../deploy/updater.mjs';

export const STATE_FILE = '/var/lib/clavarium/update/state.json';
export const CONF_FILE = '/etc/clavarium/update.conf';
export const MODES = ['auto', 'asap', 'ask', 'off'];
export const CHANNELS = ['latest', 'next'];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/;
const LOCAL = /^local-\d{8}-\d{6}$/;
const WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const HISTORY_SHOWN = 8;
/* The updater's timer (install.sh): every 15 minutes, up to 3 more at random; the registry asked at most every 6 hours in mode "ask". */
export const LOOK_EVERY_MS = 15 * 60_000;
export const ASK_EVERY_MS = 6 * 3600_000;
/* The updater's steps from which this server is about to stop (deploy/updater.mjs, #switchAndCheck). */
export const STOPPING = ['Switching', 'Restarting'];
/* A step older than this was not followed by a restart (an updater killed): no page is held by it. */
export const NOTICE_STALE_MS = 10 * 60_000;
/* state.json read for the notice at most this often: it is asked on every answer. */
const NOTICE_READ_MS = 1000;

/* WHEN IT WILL HAPPEN, for Settings: the updater's next look, and when an update may be installed. All times in
   milliseconds; the window is in this server's own time, as the updater reads it. */
export function schedule({ mode, window, lastLookAt, checkedAt, now = new Date() }) {
    const t = now.getTime();
    let nextLookAt = Number.isFinite(lastLookAt) ? lastLookAt + LOOK_EVERY_MS : null;
    if (nextLookAt !== null && nextLookAt < t) nextLookAt = null;
    const out = { mode, lookEveryMs: LOOK_EVERY_MS, lastLookAt: Number.isFinite(lastLookAt) ? lastLookAt : null, nextLookAt };
    if (mode === 'auto') {
        const [from, to] = window.split('-');
        const at = (hhmm, base) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); return d; };
        out.inWindow = inWindow(window, now);
        let opens = at(from, now); if (opens.getTime() <= t) opens = new Date(opens.getTime() + 86_400_000);
        let closes = at(to, now); if (closes.getTime() <= t) closes = new Date(closes.getTime() + 86_400_000);
        out.windowOpensAt = out.inWindow ? null : opens.getTime();
        out.windowClosesAt = closes.getTime();
    }
    if (mode === 'ask') out.askNextAt = Number.isFinite(checkedAt) ? Math.max(t, checkedAt + ASK_EVERY_MS) : null;
    return out;
}
/* When the updater's timer last ran (systemd says it to anybody), or null. */
function timerLastRun() {
    const r = spawnSync('systemctl', ['show', 'clavarium-update.timer', '-p', 'LastTriggerUSec', '--value'], { encoding: 'utf8', timeout: 5000 });
    const at = Date.parse(String(r.stdout ?? '').trim().replace(/^\w{3} /, ''));
    return Number.isFinite(at) && at > 0 ? at : null;
}
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 300) ?? '';

const RELAY_STATES = ['none', 'no-key', 'current', 'brought', 'refused', 'failed'];

export class Updates {
    #host; #state; #conf; #version; #store; #alerts; #timer; #lastLook; #lastLookCache = { at: 0, value: null }; #clock; #noticeCache = { at: -Infinity, value: '' };

    /* `host(argv)`: the host program. `store`: what was told already. */
    constructor({ host, version, stateFile = STATE_FILE, confFile = CONF_FILE, store, alerts, lastLook = timerLastRun, clock = () => Date.now() }) {
        this.#lastLook = lastLook; this.#clock = clock;
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
        const version = s.version ?? this.#version;
        /* Never offered: the version that runs, or an older one (a state written before it ran). */
        const newer = VERSION.test(s.available ?? '') && !(VERSION.test(version ?? '') && compareVersions(s.available, version) <= 0);
        const releases = Array.isArray(s.releases) ? s.releases : [];
        return {
            installed: true,
            version,
            ...this.#settings(),
            available: newer ? s.available : null,
            checkedAt: s.checkedAt ?? null,
            when: schedule({ ...this.#settings(), lastLookAt: this.#timer_(), checkedAt: s.checkedAt ? Date.parse(s.checkedAt) : null }),
            checkError: s.checkError ?? null,
            running: s.running ?? null,
            refused: s.refused ?? null,
            /* What can be gone back to: the kept releases that do not run. */
            back: releases.filter((r) => !r.current && (VERSION.test(r.id) || LOCAL.test(r.id))).map((r) => ({ id: r.id, version: r.version })),
            /* What became of the relay at the updater's last turn (deploy/updater.mjs, relay.json beside the state). */
            relay: (() => { try { const r = JSON.parse(readFileSync(join(dirname(this.#state), 'relay.json'), 'utf8')); return RELAY_STATES.includes(r.state) ? { state: r.state, version: typeof r.version === 'string' ? r.version : null, why: typeof r.why === 'string' ? r.why.slice(0, 300) : null, at: typeof r.at === 'string' ? r.at : null } : null; } catch { return null; } })(),
            history: (Array.isArray(s.history) ? s.history : []).slice(0, HISTORY_SHOWN).map(({ at, action, from, to, result, why, log }) => ({ at, action, from, to, result, why: why ?? null, log: typeof log === 'string' ? log : null })),
        };
    }

    /* AN UPDATE ABOUT TO STOP THIS SERVER: 'update <version>', 'back <version>', or ''. Said only
       from the step where the updater switches and restarts (it waits NOTICE_MS there, so that every
       page hears it), only towards another version than this one (the new server, up while the
       updater still watches it, says nothing), and only for a recent step. */
    notice() {
        const now = this.#clock();
        if (now - this.#noticeCache.at < NOTICE_READ_MS) return this.#noticeCache.value;
        const r = this.installed ? this.#read().running : null;
        const at = Date.parse(r?.at ?? '');
        const value = r && (r.action === 'update' || r.action === 'back') && STOPPING.includes(r.step) && VERSION.test(r.version ?? '') && r.version !== this.#version
            && Number.isFinite(at) && now - at < NOTICE_STALE_MS ? `${r.action} ${r.version}` : '';
        this.#noticeCache = { at: now, value };
        return value;
    }

    /* The timer's last run, asked of systemd at most once a minute. */
    #timer_() {
        if (Date.now() - this.#lastLookCache.at > 60_000) this.#lastLookCache = { at: Date.now(), value: (() => { try { return this.#lastLook(); } catch { return null; } })() };
        return this.#lastLookCache.value;
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
            const title = last.action === 'restart' ? 'The server was down: restarting it did not work' : last.result === 'rolled-back' ? `The update to ${last.to} did not work: back on ${last.from}` : `${last.action === 'back' ? 'Going back to' : 'The update to'} ${last.to} failed`;
            void this.#alerts?.tell({ title, body: String(last.why ?? '').slice(0, 180), url: '/?open=settings&at=updates' })?.catch?.(() => {});
        };
        look();
        this.#timer = setInterval(look, everyMs); this.#timer.unref?.();
        return () => clearInterval(this.#timer);
    }
}
