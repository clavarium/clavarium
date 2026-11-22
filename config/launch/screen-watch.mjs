/* screen-watch RULE... : a generic reader of the tool's terminal (02-11). Every few seconds it reads the
 * bottom of the screen of the tool (tmux) and acts on what a launcher said to look for -- nothing here
 * knows a tool: its launcher (claude-code.sh, a codex.sh...) gives the rules, so a tool that changes its
 * words is followed by changing its launcher alone.
 *
 * A rule: KIND:PATTERN[=VALUE], PATTERN a JavaScript regular expression (flag i).
 *   link:PATTERN    a link on the screen (the match): sent in the chat, to be opened by the person
 *                   (a sign-in, say); once per link.
 *   notice:PATTERN=TEXT  something the agent should know (an update installed, to be taken up by a
 *                   restart): TEXT given to the agent, as a reminder it is woken by (docket); once per screen.
 *                   The agent decides when it suits it -- never restarted in the middle of its work (02-11).
 *   keys:PATTERN=K  a question with one answer always: the keys K typed (Enter, Down, Up, Escape, 1, y...),
 *                   once per screen. Only what its launcher wrote: nothing else is ever typed.
 *   type:PATTERN=TEXT  the same with a few words (a command such as /login), then Enter; once per screen.
 *   code:PATTERN    the tool waits for a code the person gets after signing in. Nothing here acts on it: the
 *                   server reads the same rule, offers a field in the chat and types what is pasted there (#405).
 *                   A chat message is never typed as a code.
 * Only the last LINES lines are read: what the tool prints of its own work above never counts.
 *
 * THE RULES FROM THE TOOLS' CONFIGURATION (15-11, #362): `--tool ID` reads the rules of that tool from
 * screen-rules.json beside this file (written by the server from config/tools.json, "signin.screen"); its
 * link/keys/type/code rules then replace those its launcher gave, which stay as the fallback of a launcher
 * or a server older than this. Its notice rules are its launcher's always.
 *
 * A SIGN-IN LINK HANDED TO ANOTHER CONVERSATION (15-11, #362). The link is not told in the chat at once: it is
 * written in the chat folder (signin-ask.json) and the server says where it goes (signin-route.json):
 *   companion  another conversation, with a browser already signed in, opens it; the person only clicks
 *              Authorize there. The code it reads is typed here by the server; nothing is told here.
 *   person     the link told in the chat, as before (no companion, or it failed, or the person asked).
 *   done       the server typed the code.
 * No answer within HAND_MS (an older server): told to the person. The link is never written anywhere else.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINES = 12; const EVERY_MS = 3000;
const KEYS = new Set(['Enter', 'Down', 'Up', 'Left', 'Right', 'Escape', 'Tab', 'y', 'n', '1', '2', '3']);
export function rulesOf(args) {
    return args.flatMap((a) => {
        const m = /^(link|notice|keys|type|code):(.+)$/s.exec(a); if (!m) return [];
        let pattern = m[2]; let value = null;
        if (m[1] === 'type') { const at = pattern.lastIndexOf('='); if (at < 1) return []; value = pattern.slice(at + 1).slice(0, 80); pattern = pattern.slice(0, at); if (!value.trim()) return []; }
        if (m[1] === 'notice') { const at = pattern.lastIndexOf('='); if (at < 1) return []; value = pattern.slice(at + 1).trim().slice(0, 300); pattern = pattern.slice(0, at); if (!value) return []; }
        if (m[1] === 'keys') { const at = pattern.lastIndexOf('='); if (at < 1) return []; value = pattern.slice(at + 1).split(',').filter((k) => KEYS.has(k)); pattern = pattern.slice(0, at); if (!value.length) return []; }
        try { return [{ kind: m[1], re: new RegExp(pattern, 'i'), value }]; } catch { return []; }
    });
}
/* What the person pastes in the sign-in field, or the companion gives back, that may be typed as a code: no space, 10 to 300 signs. */
export const CODE = /^[A-Za-z0-9_#.~+/=-]{10,300}$/;
export const RULES_FILE = 'screen-rules.json';
const SIGNIN_KINDS = new Set(['link', 'keys', 'type', 'code']);
/* The rules of this start: those of the tool's configuration when there are any (`file`: screen-rules.json
   read, { toolId: [rule, ...] }), its launcher's notices kept; else all its launcher gave (15-11). */
export function rulesFor(args, file = null) {
    const at = args.indexOf('--tool'); const tool = at >= 0 ? args[at + 1] : null;
    const given = rulesOf(at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args);
    const own = tool && file && typeof file === 'object' && Array.isArray(file[tool]) ? rulesOf(file[tool].filter((r) => typeof r === 'string')).filter((r) => SIGNIN_KINDS.has(r.kind)) : [];
    return own.length ? [...own, ...given.filter((r) => r.kind === 'notice')] : given;
}
/* -> what to do on this screen: [{ kind, match, value }], each once (seen: a Set kept between looks). */
export function actionsOn(screen, rules, seen) {
    /* A long link the tool's screen broke over several lines (full lines, no space): put back in one. */
    const raw = String(screen).replace(/\s+$/u, '').split('\n').map((l) => l.replace(/\s+$/u, ''));
    const width = Math.max(0, ...raw.map((l) => l.length));
    const joined = [];
    for (const l of raw) { const prev = joined.at(-1); if (prev !== undefined && width > 40 && prev.length >= width - 1 && /^\S+$/.test(prev.split(' ').at(-1)) && /^\S+$/.test(l) && /https?:\/\//.test(prev)) joined[joined.length - 1] = prev + l; else joined.push(l); }
    const bottom = joined.slice(-LINES).join('\n');
    const out = [];
    for (const r of rules) {
        const m = r.re.exec(bottom); if (!m) continue;
        const key = `${r.kind}:${r.kind === 'link' ? m[0] : bottom}`;
        if (seen.has(key)) continue;
        /* A notice once an hour at most: its own words on the screen never bring it back in a loop. */
        if (r.kind === 'notice' && Date.now() - (r.last ?? 0) < 60 * 60_000) { seen.add(key); continue; }
        if (r.kind === 'notice') r.last = Date.now();
        /* With a link, the lines around it (a code to type there, often): the person sees what the tool said. */
        const lines = bottom.split('\n'); const i = lines.findIndex((l) => l.includes(m[0].split('\n')[0]));
        const around = r.kind === 'link' && i >= 0 ? lines.slice(Math.max(0, i - 2), i + 4).map((l) => l.trim()).filter(Boolean).join('\n') : '';
        seen.add(key); out.push({ kind: r.kind, match: m[0], value: r.value, around });
    }
    if (seen.size > 200) for (const k of [...seen].slice(0, 100)) seen.delete(k);
    return out;
}

/* Where a sign-in link goes, step by step (15-11, #362): what to do, as a list of effects the caller runs --
   { do: 'ask', ask } (write signin-ask.json), 'tell-link' { a } (the link in the person's chat). `field: true` in
   the ask: this watcher reads no code from the chat (#405; an older one does, see SigninHelp.oldWatcherArmed).
   `route()`: signin-route.json as read, or null. */
export const HAND_MS = 20_000;
export class Relay {
    #ask = null; #now; #id; #route; #chat;
    constructor({ route = () => null, chat = () => true, now = () => Date.now(), id = () => randomUUID() } = {}) { this.#route = route; this.#chat = chat; this.#now = now; this.#id = id; }
    /* Told to the person: the ask says so too (`told`), so that a server that reads it late hands it to nobody. */
    #person() { const a = this.#ask; a.route = 'person'; return [{ do: 'ask', ask: { ...a.file, told: true } }, { do: 'tell-link', a: a.a }]; }
    link(a) {
        /* No chat folder: nowhere to hand it over, nobody but the person (and the chat is off anyway). */
        if (!this.#chat()) return [{ do: 'tell-link', a }];
        const id = this.#id(); const at = this.#now();
        this.#ask = { id, at, a, route: null, file: { id, at: new Date(at).toISOString(), link: a.match, around: a.around ?? '', field: true } };
        return [{ do: 'ask', ask: this.#ask.file }];
    }
    step() {
        const a = this.#ask; if (!a || a.route === 'person') return [];
        const r = this.#route(); const mine = r && r.id === a.id ? r.route : null;
        if (mine === 'done') { this.#ask = null; return []; }
        if (mine === 'person') return this.#person();
        if (mine === 'companion') { a.route = 'companion'; return []; }
        if (a.route === null && this.#now() - a.at > HAND_MS) return this.#person();
        return [];
    }
}

const main = process.argv[1]?.endsWith('screen-watch.mjs');
if (main) {
    let file = null; try { file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), RULES_FILE), 'utf8')); } catch { /* none: its launcher's rules */ }
    const rules = rulesFor(process.argv.slice(2), file);
    const tmux = ['-L', process.env.SCREEN_WATCH_SOCKET ?? 'clavarium'];
    const pane = process.env.SCREEN_WATCH_PANE ?? '=main:';
    const chat = process.env.PARLEY_DIR ?? '/work/.parley';
    const seen = new Set();
    /* The sign-in link's way (Relay): asked in the chat folder, routed by the server. */
    const readRoute = () => { try { return JSON.parse(readFileSync(`${chat}/signin-route.json`, 'utf8')); } catch { return null; } };
    const relay = new Relay({ route: readRoute, chat: () => existsSync(chat) });
    const run = (effects) => {
        for (const e of effects) {
            if (e.do === 'ask') { try { writeFileSync(`${chat}/.signin-ask.json.new`, JSON.stringify(e.ask)); renameSync(`${chat}/.signin-ask.json.new`, `${chat}/signin-ask.json`); } catch { /* not written: no answer comes, told to the person after HAND_MS */ } }
            if (e.do === 'tell-link') spawnSync('parley', ['tell', `Your tool asks you to open this link: ${e.a.match}${e.a.around && e.a.around !== e.a.match ? `\n\n\`\`\`\n${e.a.around}\n\`\`\`` : ''}`, '--dir', chat], { timeout: 10_000 });
        }
    };
    const look = () => {
        run(relay.step());
        const r = spawnSync('tmux', [...tmux, 'capture-pane', '-p', '-t', pane], { encoding: 'utf8', timeout: 5000 });
        if (r.status !== 0) return;
        for (const a of actionsOn(r.stdout, rules, seen)) {
            if (a.kind === 'link') run(relay.link(a));
            if (a.kind === 'notice') spawnSync('docket', ['remind', '--in', '1m', a.value, '--dir', process.env.DOCKET_DIR ?? '/work/.docket'], { timeout: 10_000 });
            if (a.kind === 'keys') for (const k of a.value) spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, k], { timeout: 5000 });
            if (a.kind === 'type') { spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, '-l', '--', a.value], { timeout: 5000 }); spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, 'Enter'], { timeout: 5000 }); }
        }
    };
    /* Its life is the tool's: started just before the launcher becomes the tool (exec), it ends with it. */
    const tool = process.ppid;
    const alive = () => { try { process.kill(tool, 0); return true; } catch { return false; } };
    if (rules.length) setInterval(() => { if (!alive()) process.exit(0); look(); }, EVERY_MS);
}
