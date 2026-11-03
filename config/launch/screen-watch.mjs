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
 *   code:PATTERN    the tool waits for a code the person gets after signing in: the next message they write
 *                   in the chat that looks like one (no space, 10 to 300 signs) is typed there, then Enter.
 * Only the last LINES lines are read: what the tool prints of its own work above never counts.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

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

const main = process.argv[1]?.endsWith('screen-watch.mjs');
if (main) {
    const rules = rulesOf(process.argv.slice(2));
    const tmux = ['-L', process.env.SCREEN_WATCH_SOCKET ?? 'clavarium'];
    const pane = process.env.SCREEN_WATCH_PANE ?? '=main:';
    const chat = process.env.PARLEY_DIR ?? '/work/.parley';
    const seen = new Set();
    /* Waiting for a code: the person's chat, from where it stood when the tool asked (to-agent.jsonl). */
    let awaiting = null;
    const inbox = `${chat}/to-agent.jsonl`;
    const codeFrom = () => { try { return statSync(inbox).size; } catch { return 0; } };
    const typeCode = () => {
        if (awaiting === null) return;
        let text = ''; try { const b = readFileSync(inbox); text = b.subarray(awaiting).toString('utf8'); } catch { return; }
        for (const line of text.split('\n').filter(Boolean)) {
            let m; try { m = JSON.parse(line); } catch { continue; }
            const code = String(m?.text ?? '').trim();
            if (/^[A-Za-z0-9_#.~+/=-]{10,300}$/.test(code)) {
                spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, '-l', '--', code], { timeout: 5000 });
                spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, 'Enter'], { timeout: 5000 });
                awaiting = null; return;
            }
        }
    };
    const look = () => {
        typeCode();
        const r = spawnSync('tmux', [...tmux, 'capture-pane', '-p', '-t', pane], { encoding: 'utf8', timeout: 5000 });
        if (r.status !== 0) return;
        for (const a of actionsOn(r.stdout, rules, seen)) {
            if (a.kind === 'link') spawnSync('parley', ['tell', `Your tool asks you to open this link: ${a.match}${a.around && a.around !== a.match ? `\n\n\`\`\`\n${a.around}\n\`\`\`` : ''}`, '--dir', chat], { timeout: 10_000 });
            if (a.kind === 'notice') spawnSync('docket', ['remind', '--in', '1m', a.value, '--dir', process.env.DOCKET_DIR ?? '/work/.docket'], { timeout: 10_000 });
            if (a.kind === 'keys') for (const k of a.value) spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, k], { timeout: 5000 });
            if (a.kind === 'type') { spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, '-l', '--', a.value], { timeout: 5000 }); spawnSync('tmux', [...tmux, 'send-keys', '-t', pane, 'Enter'], { timeout: 5000 }); }
            if (a.kind === 'code') { awaiting = codeFrom(); spawnSync('parley', ['tell', 'Once signed in, paste here the code the page gives you.', '--dir', chat], { timeout: 10_000 }); }
        }
    };
    /* Its life is the tool's: started just before the launcher becomes the tool (exec), it ends with it. */
    const tool = process.ppid;
    const alive = () => { try { process.kill(tool, 0); return true; } catch { return false; } };
    if (rules.length) setInterval(() => { if (!alive()) process.exit(0); look(); }, EVERY_MS);
}
