/* screen-watch RULE... : a generic reader of the tool's terminal (02-11). Every few seconds it reads the
 * bottom of the screen of the tool (tmux) and acts on what a launcher said to look for -- nothing here
 * knows a tool: its launcher (claude-code.sh, a codex.sh...) gives the rules, so a tool that changes its
 * words is followed by changing its launcher alone.
 *
 * A rule: KIND:PATTERN[=VALUE], PATTERN a JavaScript regular expression (flag i).
 *   link:PATTERN    a link on the screen (the match): sent in the chat, to be opened by the person
 *                   (a sign-in, say); once per link.
 *   restart:PATTERN the tool asks to be restarted (an update to apply): asked of the server, which does it
 *                   once the tool's turn has ended (/work/.parley/restart-asked); once per screen.
 *   keys:PATTERN=K  a question with one answer always: the keys K typed (Enter, Down, Up, Escape, 1, y...),
 *                   once per screen. Only what its launcher wrote: nothing else is ever typed.
 * Only the last LINES lines are read: what the tool prints of its own work above never counts.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const LINES = 12; const EVERY_MS = 3000;
const KEYS = new Set(['Enter', 'Down', 'Up', 'Left', 'Right', 'Escape', 'Tab', 'y', 'n', '1', '2', '3']);
export function rulesOf(args) {
    return args.flatMap((a) => {
        const m = /^(link|restart|keys):(.+)$/s.exec(a); if (!m) return [];
        let pattern = m[2]; let value = null;
        if (m[1] === 'keys') { const at = pattern.lastIndexOf('='); if (at < 1) return []; value = pattern.slice(at + 1).split(',').filter((k) => KEYS.has(k)); pattern = pattern.slice(0, at); if (!value.length) return []; }
        try { return [{ kind: m[1], re: new RegExp(pattern, 'i'), value }]; } catch { return []; }
    });
}
/* -> what to do on this screen: [{ kind, match, value }], each once (seen: a Set kept between looks). */
export function actionsOn(screen, rules, seen) {
    const bottom = String(screen).replace(/\s+$/u, '').split('\n').slice(-LINES).join('\n');
    const out = [];
    for (const r of rules) {
        const m = r.re.exec(bottom); if (!m) continue;
        const key = `${r.kind}:${r.kind === 'link' ? m[0] : bottom}`;
        if (seen.has(key)) continue;
        seen.add(key); out.push({ kind: r.kind, match: m[0], value: r.value });
    }
    if (seen.size > 200) for (const k of [...seen].slice(0, 100)) seen.delete(k);
    return out;
}

const main = process.argv[1]?.endsWith('screen-watch.mjs');
if (main) {
    const rules = rulesOf(process.argv.slice(2));
    const tmux = ['-L', process.env.SCREEN_WATCH_SOCKET ?? 'clavarium'];
    const pane = process.env.SCREEN_WATCH_PANE ?? '=main:';
    const chat = process.env.PARLEY_DIR ?? '/work/.parley';
    const seen = new Set();
    const look = () => {
        const r = spawnSync('tmux', [...tmux, 'capture-pane', '-p', '-t', pane], { encoding: 'utf8', timeout: 5000 });
        if (r.status !== 0) return;
        for (const a of actionsOn(r.stdout, rules, seen)) {
            if (a.kind === 'link') spawnSync('parley', ['tell', `Your tool asks you to open this link: ${a.match}`, '--dir', chat], { timeout: 10_000 });
            if (a.kind === 'restart' && existsSync(chat)) { try { writeFileSync(`${chat}/restart-asked`, ''); } catch { /* the chat is not there */ } }
            if (a.kind === 'keys') for (const k of a.value) spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, k], { timeout: 5000 });
        }
    };
    /* Its life is the tool's: started just before the launcher becomes the tool (exec), it ends with it. */
    const tool = process.ppid;
    const alive = () => { try { process.kill(tool, 0); return true; } catch { return false; } };
    if (rules.length) setInterval(() => { if (!alive()) process.exit(0); look(); }, EVERY_MS);
}
