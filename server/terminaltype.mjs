/* TYPED INTO A TOOL'S TERMINAL: the one way this server types there (17-11).
 *
 * Any tool (Claude Code, Vibe, OpenCode...) runs in the tmux pane of its
 * conversation's machine. What this server types there -- the chat's line
 * (talk.mjs), a wake-up and the docket's line (wakeups.mjs, dockets.mjs), a
 * server line (gitkeeper.mjs, guide.mjs...), an answer (answerer.mjs), a
 * sign-in code (signinhelp.mjs), the Esc of an API key (apikeys.mjs) -- goes
 * through here, typed the same way:
 *
 *   WARM FIRST        the terminal of a machine that runs is opened, if it
 *                     is not (the tool is started with it).
 *   NEVER OVER A PERSON  a line waits while somebody types in that terminal
 *                     from a screen (TypingWatch, wakeups.mjs), a while at most
 *                     (or is not typed, for what is only right now: an answer):
 *                     typed into a command being typed, both were broken (seen 24-10).
 *   ONE COMMAND       copy mode left, the line, a pause, Enter: one tmux
 *                     command in the machine (typeCommand).
 *   ELSE ITS TERMINAL the terminal the bridge keeps open on the same pane,
 *                     only when that command failed.
 *   SAID IN THE LOG   each line typed, each one lost, with why.
 *
 * TWO WAYS INTO A TOOL, AND ONLY TWO: its files (.parley, .docket: what is
 * to be read, the content itself) and its terminal. What is typed there is a
 * DOORBELL (ring): one short line, never content, that sends the tool to its
 * files -- its delivery known from what the tool writes there (Parley's read
 * count, talk.mjs; the docket's acknowledgements, dockets.mjs), rung again
 * until then. typeLine types real text, for the few lines that are content
 * (a wake-up's own words, set by its owner; an answer; a sign-in code): the
 * same command, the same log.
 *
 * What a person types from the page's terminal never comes here: that is the
 * person typing, down the bridge (bridge.mjs).
 */
import { WAKE as CHAT_WAKE, URGENT as CHAT_URGENT } from 'clavarium-parley/host';
import { WAKE as DOCKET_WAKE } from 'clavarium-docket/host';
import { SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';

const PANE = `=${SESSION}:`;
/* THE LINE AND ITS ENTER ARE TYPED APART, this long apart. Arriving in one
   read, "text" and Enter look like a paste to a tool that guesses pastes from
   how fast the keys come (measured in tmux: send-keys of both in one command
   gives the program one read, "text\r"): the Enter is then a new line in its
   input, not a send. Waited inside the same tmux command (run-shell -d) or
   by the terminal bridge: no second call into the machine. */
export const ENTER_AFTER_MS = 200;
/* A line waits this long at most for the person typing to stop, looked at this often. */
export const HOLD_MAX_MS = 5 * 60_000;
export const HOLD_STEP_MS = 1000;
/* A PANE SCROLLED BACK IS IN COPY MODE (`mouse on`: the wheel of any screen puts it there, and it stays
   there when that screen goes away): the keys of a line typed then are copy-mode commands, the line never
   reaches the tool and its Enter only leaves the mode (tried with tmux 3.4). The mode is left first, in
   the same command -- nothing is done to a pane that is not in a mode (no shell: -F reads a format). */
const LEAVE_MODE = ['if-shell', '-F', '-t', PANE, '#{pane_in_mode}', `send-keys -t ${PANE} -X cancel`, ';'];
/* The one tmux command that types a line, waits, and presses Enter: an
   argument vector, no shell. tmux reads an argument that ENDS with ";" as the
   end of a command: such a last ";" is written "\;", which tmux gives back
   as ";" (tried). */
export function typeCommand(line) {
    const text = line.endsWith(';') ? `${line.slice(0, -1)}\\;` : line;
    return ['tmux', '-L', SOCKET, ...LEAVE_MODE, 'send-keys', '-t', PANE, '-l', '--', text, ';', 'run-shell', '-d', String(ENTER_AFTER_MS / 1000), ';', 'send-keys', '-t', PANE, 'Enter'];
}
/* Where the line is in typeCommand's argument vector. */
export const TYPED_AT = 3 + LEAVE_MODE.length + 5;
/* One key alone (a tmux key name: Enter, Escape, Up, y...), copy mode left first in the same command. */
export const keyCommand = (key) => ['tmux', '-L', SOCKET, ...LEAVE_MODE, 'send-keys', '-t', PANE, key];
export const enterCommand = () => keyCommand('Enter');
/* Escape, alone: what the Esc key of the page's key row sends -- a tool's current turn stopped (an API key that may act, apikeys.mjs). */
export const escapeCommand = () => keyCommand('Escape');

/* THE DOORBELLS, by what rings: its line, who says it in the log, how the log names it. */
export const DOORBELLS = Object.freeze({
    chat: Object.freeze({ line: CHAT_WAKE, why: 'talk', what: 'wake' }),
    'chat-urgent': Object.freeze({ line: CHAT_URGENT, why: 'talk', what: 'urgent' }),
    docket: Object.freeze({ line: DOCKET_WAKE, why: 'docket', what: 'wake' }),
});

const cut = (line) => (line.length > 60 ? `${line.slice(0, 60)}...` : line);

export class TerminalType {
    #vms; #terminal; #warm; #typing; #log; #now; #pause;

    /* `vms.exec(name, argv, options)`: a command in the machine. `terminal`: the bridge's { open(name),
       type(name, line, ms) } (bridge.mjs), or none. `warm(name)`: opens its terminal. `typing(name)`:
       somebody types there now (TypingWatch). `log(line)`: the server's log. */
    constructor({ vms, terminal = null, warm = async () => {}, typing = () => false, log = (line) => console.log(line), now = () => Date.now(), pause = (ms) => new Promise((ok) => { setTimeout(ok, ms).unref?.(); }) }) {
        this.#vms = vms; this.#terminal = terminal; this.#warm = warm; this.#typing = typing; this.#log = log; this.#now = now; this.#pause = pause;
    }

    /* Whether somebody types in its terminal now. */
    busy(name) { try { return this.#typing(name) === true; } catch { return false; } }

    async #exec(name, argv) {
        return this.#vms.exec(name, argv, { timeoutMs: 30_000 }).catch((error) => ({ code: -1, stderr: error?.message }));
    }

    /* Types `line` and Enter. Resolves true when it went. `why`: who types, the log's first word.
       `what`: how the log names it (the line cut short by default; `secret`: never named). `hold`:
       how long it waits for the person typing there before it types anyway; 0: it is then not typed. */
    async typeLine(name, line, { why = 'server', what, secret = false, hold = HOLD_MAX_MS } = {}) {
        const text = String(line);
        const named = secret ? 'not shown' : what ?? cut(text);
        await Promise.resolve(this.#warm(name)).catch(() => {});
        if (hold <= 0 && this.busy(name)) { this.#log(`${why}: ${name}: NOT typed (${named}): somebody types there`); return false; }
        /* Held a while at most: a line left half typed does not keep the server silent. */
        const start = this.#now();
        while (this.busy(name) && this.#now() - start < hold) await this.#pause(HOLD_STEP_MS);
        const held = this.busy(name) ? `, after ${Math.round(hold / 1000)} s with somebody typing there` : '';
        const ran = await this.#exec(name, typeCommand(text));
        if (ran.code === 0) { this.#log(`${why}: ${name}: typed (${named})${held}`); return true; }
        const failed = `exit ${ran.code}${ran.stderr ? `: ${String(ran.stderr).trim().slice(0, 200)}` : ''}`;
        const open = Boolean(this.#terminal?.open(name));
        const down = open ? await Promise.resolve(this.#terminal.type(name, text, ENTER_AFTER_MS)).catch(() => false) : false;
        /* The line went, its Enter did not (the channel closed meanwhile): the Enter alone, never the line twice. */
        const ok = down === true || (down === 'enter' && (await this.#exec(name, enterCommand())).code === 0);
        this.#log(ok ? `${why}: ${name}: typed down its terminal (${named}), the command in the machine failed (${failed})` : `${why}: ${name}: NOT typed (${named}): ${failed}; ${open ? 'its terminal refused too' : 'no terminal open'}`);
        return ok;
    }

    /* The doorbell of `source` (DOORBELLS): typed as any line is. Whether it was heard is the caller's to
       know, from the tool's files, and to ring again. Resolves true when it was typed. */
    async ring(name, source) {
        const bell = DOORBELLS[source];
        if (!bell) throw new RangeError(`No such doorbell: ${source}`);
        return this.typeLine(name, bell.line, { why: bell.why, what: bell.what });
    }

    /* One key alone (a tmux key name), now: an act asked for, not a line -- it does not wait for the person. */
    async sendKey(name, key, { why = 'server' } = {}) {
        const ran = await this.#exec(name, keyCommand(String(key)));
        if (ran.code === 0) { this.#log(`${why}: ${name}: key ${key}`); return true; }
        this.#log(`${why}: ${name}: key ${key} NOT sent: exit ${ran.code}${ran.stderr ? `: ${String(ran.stderr).trim().slice(0, 200)}` : ''}`);
        return false;
    }
}
