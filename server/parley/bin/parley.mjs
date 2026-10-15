#!/usr/bin/env node
/* THE COMMAND: the six verbs for any agent that can run a command. It writes
 * the same files as the MCP server, through the same code (server/).
 *
 *   parley read | tell | ask | show | doing | status | --help
 *
 * Exit codes: 0 done; 1 refused (said on standard error); 2 no folder found;
 * 64 not understood. */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridge, findFolder, STATES, VERSION, FOLDER } from '../server/parley-mcp.mjs';

export const HELP = `parley: talk with the person you work for. They read and answer on their own screen, not in this terminal.

  parley read                          read what they wrote since you last read, answers included
  parley tell "text"                   tell them something: where you are, what you did, what you found
  parley ask "question" [choice ...]   ask them something; give the answers they can pick when you can
  parley show path ["note"]            point them to a file you made, so that they can open it
  parley doing "text"                  say in one short line what you are doing now, each time you
                                       move to something new: "reading the 12 recordings"
  parley status ${STATES.join('|')} ["note"]
                                       say where you are: working when you start, waiting when you
                                       need them, done when the task is finished

Say what you are doing with "parley doing" at each new step: their screen shows it while you
work, and keeps it one click away once your next message came.

Nothing waits. After "ask", go on with something else, or stop: when they write, you are told in
the terminal ("You have a new message"). Then run "parley read".

Write to them in plain words, in their language. Put a file you show in a folder you share with
them; one outside it cannot be opened from their screen.

Text can come from standard input, with "-":   parley tell - <<'EOF'
                                                ...
                                                EOF
The folder used is --dir FOLDER, else $PARLEY_DIR, else the nearest ${FOLDER} folder from here up.
parley ${VERSION}`;

/* Runs one command line. Resolves with { code, out, err }: nothing is printed
   here, so that it can be tested without a terminal. */
export function run(argv, { env = process.env, cwd = process.cwd(), stdin = () => readFileSync(0, 'utf8') } = {}) {
    const args = [...argv];
    let dir;
    const at = args.indexOf('--dir');
    if (at >= 0) { dir = args[at + 1]; if (!dir) return { code: 64, out: '', err: '--dir needs a folder.\n' }; args.splice(at, 2); }
    const [verb, ...rest] = args;
    if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') return { code: 0, out: `${HELP}\n`, err: '' };
    if (verb === '--version') return { code: 0, out: `${VERSION}\n`, err: '' };
    if (!['read', 'tell', 'ask', 'show', 'doing', 'status'].includes(verb)) return { code: 64, out: '', err: `Unknown: ${verb}. Run "parley --help".\n` };
    const folder = findFolder({ dir, env, from: cwd });
    if (!folder) return { code: 2, out: '', err: `No ${FOLDER} folder here or above. Run it from your work folder, or give --dir FOLDER.\n` };
    const text = (value) => (value === '-' ? stdin().replace(/\n$/, '') : value);
    const verbs = bridge(folder);
    try {
        let said;
        if (verb === 'read') said = verbs.read();
        else if (verb === 'tell') said = verbs.tell(text(rest.join(' ')));
        else if (verb === 'ask') said = verbs.ask(text(rest[0]), rest.slice(1));
        else if (verb === 'doing') said = verbs.doing(text(rest.join(' ')));
        else if (verb === 'show') said = verbs.show(rest[0], rest.slice(1).join(' '), { from: cwd });
        else said = verbs.status(rest[0], rest.slice(1).join(' '));
        return { code: 0, out: `${said}\n`, err: '' };
    } catch (error) {
        return { code: 1, out: '', err: `Not done: ${error.message}. Run "parley --help".\n` };
    }
}

const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (main) {
    const { code, out, err } = run(process.argv.slice(2));
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    process.exitCode = code;
}
