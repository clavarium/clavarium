/* THE HEARTBEAT OF A MACHINE (step 6, phase 1): its health looked at from inside it, read from here.
 *
 * Every two minutes, each conversation's health was one command into its machine (health.mjs, PROBE): one
 * more line at the VM manager, in front of every other command. Now a timer in the machine (root's,
 * config/machine/clavarium-beat) runs that same probe every minute, as the conversation's own user, and
 * writes what it printed into its work folder, /work/.clavarium/beat.json. The work folder is a folder of
 * THIS server: the beat is read here, as a file (read), with no command at all.
 *
 * WHAT IS IN IT IS THE AGENT'S: it is root in its machine and may write anything there. So the folder must
 * be a folder (never a link), the file a plain file of a few kilobytes, opened without following a link and
 * without waiting (a pipe put there); its words checked one by one; its conversation the one whose folder it
 * is; its age taken from THIS server's clock (the file's time here), never from what it says; its number
 * growing. Nothing in it is ever run: its probe text is read by readProbe, as the probe's output always was.
 *
 * Put in a machine once (ensure): one command at its start or opening, skipped when a fresh beat already
 * says this version. Only with CLAVARIUM_BEAT holding `health` (main.mjs): off, nothing here is used.
 */
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants, writeFileSync, renameSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROBE } from './health.mjs';

export const FOLDER = '.clavarium';
export const BEAT_FILE = 'beat.json';
export const EXPECTED_FILE = 'expected';
/* At most this big: a probe of 64 secrets' names is a few kilobytes. */
export const BEAT_BYTES = 16 * 1024;
/* Older than this (by this server's clock), it says nothing: its timer beats every minute or so. */
export const FRESH_MS = 180_000;
/* A file's time a little ahead of this server's clock is still now (a share's rounding); more is not believed. */
const AHEAD_MS = 10_000;
/* Where it is put in the machine (root's, never under /tools or /work). */
export const LIB = '/usr/local/lib/clavarium';
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const INSTALL_MS = 90_000;
const NAME = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
const VERSION_WORD = /^[0-9A-Za-z.+-]{1,64}$/;

/* Whether CLAVARIUM_BEAT asks for it (`health`; other words for the later phases). */
export const beatWanted = (value, what = 'health') => String(value ?? '').split(/[\s,]+/).includes(what);

const RUNNER = new URL('../config/machine/clavarium-beat', import.meta.url);
const ONE = new URL('../config/machine/clavarium-beat-one', import.meta.url);
export const SERVICE = `[Unit]
Description=Clavarium heartbeat: its health, for its server
[Service]
Type=oneshot
ExecStart=/bin/sh ${LIB}/beat-all
TimeoutStartSec=300
Nice=10
`;
export const TIMER = `[Unit]
Description=Clavarium heartbeat, every minute
[Timer]
OnBootSec=20s
OnUnitActiveSec=60s
RandomizedDelaySec=10s
AccuracySec=5s
[Install]
WantedBy=timers.target
`;

/* THE ONE COMMAND THAT PUTS IT IN A MACHINE, as root: its scripts and the probe in LIB, its settings, its
   service and timer, started. Its arguments (mode, conversation, version) are checked again there. Each file
   is written aside, then moved: a beat that runs meanwhile finds the old or the new, never half of one. */
const EOF = 'CLAVARIUM_BEAT_EOF';
function here(text) {
    if (String(text).split('\n').includes(EOF)) throw new Error('a file of the beat holds its own end mark');
    return `<<'${EOF}'\n${String(text).replace(/\n?$/, '\n')}${EOF}\n`;
}
export function installScript() {
    return [
        'set -eu',
        'mode="$1"; name="$2"; version="$3"',
        'case "$mode" in own) printf \'%s\' "$name" | grep -Eq \'^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$\' || exit 64 ;; shared) name=- ;; *) exit 64 ;; esac',
        'printf \'%s\' "$version" | grep -Eq \'^[0-9A-Za-z.+-]{1,64}$\' || exit 64',
        `lib=${LIB}`,
        'mkdir -p "$lib"; chown root:root "$lib"; chmod 755 "$lib"',
        'put() { tmp="$lib/.$1.$$"; cat > "$tmp"; chmod "$2" "$tmp"; mv -f "$tmp" "$lib/$1"; }',
        `put probe.sh 0644 ${here(PROBE)}`,
        `put beat-one 0755 ${here(readFileSync(ONE, 'utf8'))}`,
        `put beat-all 0755 ${here(readFileSync(RUNNER, 'utf8'))}`,
        'printf \'mode=%s\\nconversation=%s\\nversion=%s\\n\' "$mode" "$name" "$version" | put beat.conf 0644',
        `cat > /etc/systemd/system/clavarium-beat.service ${here(SERVICE)}`,
        `cat > /etc/systemd/system/clavarium-beat.timer ${here(TIMER)}`,
        'systemctl daemon-reload',
        'systemctl enable --now clavarium-beat.timer >/dev/null 2>&1',
        'systemctl start --no-block clavarium-beat.service',
    ].join('\n');
}
export const INSTALL_NAME = 'clavarium-beat-install';

export class Beat {
    #vms; #workFolder; #conversations; #now; #version; #seq = new Map(); #expected = new Map(); #tried = new Map(); #installing = new Map();
    /* `on`: CLAVARIUM_BEAT holds `health`. `workFolder(name)`: its work folder on this server.
       `conversations`: get(name) -- whether its work is kept here. */
    constructor({ on = false, vms, workFolder, conversations, now = () => Date.now(), version = VERSION }) {
        this.on = Boolean(on); this.#vms = vms; this.#workFolder = workFolder; this.#conversations = conversations; this.#now = now; this.#version = version;
    }
    get version() { return this.#version; }

    #dir(name) { if (!NAME.test(String(name))) throw new Error('not a conversation name'); return join(this.#workFolder(name), FOLDER); }
    /* Its folder, a folder of its own (never a link), or null; made when `make` and missing. */
    #folder(name, make = false) {
        let dir;
        try { dir = this.#dir(name); } catch { return null; }
        let s = lstatSync(dir, { throwIfNoEntry: false });
        if (!s && make) { try { mkdirSync(dir, { mode: 0o755 }); } catch { return null; } s = lstatSync(dir, { throwIfNoEntry: false }); }
        return s && s.isDirectory() && !s.isSymbolicLink() ? dir : null;
    }

    /* WHAT SHOULD BE MOUNTED, for the beat to look at (resources.expected): written when it changed. */
    expect(name, paths) {
        if (!this.on) return false;
        const text = `${paths.filter((p) => /^\/[A-Za-z0-9._/-]{1,200}$/.test(p)).slice(0, 100).join('\n')}\n`;
        try {
            const dir = this.#folder(name, true);
            if (!dir) return false;
            const at = join(dir, EXPECTED_FILE);
            const s = lstatSync(at, { throwIfNoEntry: false });
            if (this.#expected.get(name) === text && s?.isFile()) return true;
            /* Aside, then moved: a link put at its place is replaced, never followed. */
            const tmp = join(dir, `.expected.${randomBytes(6).toString('hex')}`);
            try { writeFileSync(tmp, text, { flag: 'wx', mode: 0o644 }); renameSync(tmp, at); } catch (error) { rmSync(tmp, { force: true }); throw error; }
            this.#expected.set(name, text);
            return true;
        } catch { return false; }
    }

    /* ITS LAST BEAT: { ok: true, text, version, seq, at } or { ok: false, why }. `peek`: its number not
       taken as seen (the install's look). */
    read(name, { peek = false } = {}) {
        const dir = this.#folder(name);
        if (!dir) return { ok: false, why: 'none' };
        let fd;
        try { fd = openSync(join(dir, BEAT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { return { ok: false, why: error.code === 'ENOENT' ? 'none' : 'unreadable' }; }
        let s; let text;
        try {
            s = fstatSync(fd);
            if (!s.isFile()) return { ok: false, why: 'not a file' };
            if (s.size > BEAT_BYTES) return { ok: false, why: 'too big' };
            const buf = Buffer.alloc(BEAT_BYTES + 1);
            let n = 0;
            for (let got = 1; got > 0 && n <= BEAT_BYTES; n += got) got = readSync(fd, buf, n, BEAT_BYTES + 1 - n, null);
            if (n > BEAT_BYTES) return { ok: false, why: 'too big' };
            text = buf.toString('utf8', 0, n);
        } catch { return { ok: false, why: 'unreadable' }; } finally { closeSync(fd); }
        const age = this.#now() - s.mtimeMs;
        if (age > FRESH_MS) return { ok: false, why: 'stale' };
        if (age < -AHEAD_MS) return { ok: false, why: 'ahead' };
        let j;
        try { j = JSON.parse(text); } catch { return { ok: false, why: 'not json' }; }
        if (!j || typeof j !== 'object' || j.v !== 1) return { ok: false, why: 'not a beat' };
        if (j.conversation !== name) return { ok: false, why: 'another conversation' };
        if (!Number.isSafeInteger(j.seq) || j.seq < 1) return { ok: false, why: 'no number' };
        if (typeof j.version !== 'string' || !VERSION_WORD.test(j.version)) return { ok: false, why: 'no version' };
        if (typeof j.probe !== 'string') return { ok: false, why: 'no probe' };
        /* ITS NUMBER GROWS: the same beat read again (same number, same time) is still it; a smaller one, or
           the same number written again, is not believed -- and the next one is taken as a new start. */
        const last = this.#seq.get(name);
        if (last && !(j.seq > last.seq || (j.seq === last.seq && s.mtimeMs === last.at))) { if (!peek) this.#seq.delete(name); return { ok: false, why: 'number' }; }
        if (!peek) this.#seq.set(name, { seq: j.seq, at: s.mtimeMs });
        return { ok: true, text: j.probe, version: j.version, seq: j.seq, at: s.mtimeMs };
    }

    /* PUT IN ITS MACHINE, once: one command, as root. Skipped when its beat is fresh and says this version,
       or when it was tried already for this version (`woke`: its machine has just started -- what was tried
       is forgotten: a fresh beat may still be from before its start, and once it is stale the next call puts
       it again). Never more than
       one at a time per conversation. Resolves with what was done: 'off', 'fresh', 'tried', 'put', 'failed'. */
    ensure(name, { woke = false } = {}) {
        if (!this.on || this.#conversations?.get(name)?.work !== 'kept') return Promise.resolve('off');
        if (woke) this.#tried.delete(name);
        const going = this.#installing.get(name);
        if (going) return going;
        const beat = this.read(name, { peek: true });
        if (beat.ok && beat.version === this.#version) return Promise.resolve('fresh');
        if (this.#tried.get(name) === this.#version) return Promise.resolve('tried');
        this.#tried.set(name, this.#version);
        const mode = this.#vms.shared?.(name) ? 'shared' : 'own';
        const run = this.#vms.execMachine(name, ['sudo', '-n', 'sh', '-c', installScript(), INSTALL_NAME, mode, mode === 'own' ? name : '-', this.#version], { timeoutMs: INSTALL_MS })
            .then((r) => (r.code === 0 ? 'put' : 'failed'), () => 'failed')
            .finally(() => this.#installing.delete(name));
        this.#installing.set(name, run);
        return run;
    }

    forget(name) { this.#seq.delete(name); this.#expected.delete(name); this.#tried.delete(name); }
}
