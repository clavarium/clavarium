/* THE TOOL RUNS ALONE IN ITS TMUX SESSION, NEVER BEHIND A SHELL.
 *
 * Measured before this was written: text typed into a shell where the tool
 * has exited is EXECUTED as a command. With the tool as the session's only
 * program, the session ends when the tool exits and there is nothing left to
 * type into.
 *
 * `-A` attaches when the session already exists, so a page reload, a second
 * device or a restart of this server all find the same running tool. The
 * server keeps no terminal state: tmux does.
 *
 * Everything is an argument vector. No shell ever parses a name or a command.
 */
import { isConversationName } from './names.mjs';

/* A tmux server of our own, so that nothing here can touch a session the
   machine's user started for themselves. */
export const SOCKET = 'clavarium';

/* `escape-time`: tmux waits 500 ms after Escape by default to see whether it
   starts a longer key. Measured: that swallows an Escape followed by typing.
   `status off`: the page draws its own header. `mouse on`: the wheel scrolls. */
/* Each one is a tmux command of its own, appended after the tool's command. */
const SETTINGS = [
    ['set', '-sg', 'escape-time', '10'],
    ['set', '-g', 'status', 'off'],
    ['set', '-g', 'mouse', 'on'],
    /* Asked for by a tool itself, on its own screen, during the first real
       run: without it the tool cannot tell when its terminal gains focus. */
    ['set', '-g', 'focus-events', 'on'],
];

export function attachCommand(name, command, cwd) {
    if (!isConversationName(name)) throw new Error('not a conversation name');
    if (!Array.isArray(command) || command.length === 0 || command.some((a) => typeof a !== 'string' || a === '')) {
        throw new Error('a conversation needs a command to run');
    }
    /* A lone ";" would end the tool's command and start a tmux one. */
    if (command.includes(';')) throw new Error('the command cannot contain a bare ";"');
    const argv = ['tmux', '-L', SOCKET, 'new-session', '-A', '-s', name];
    if (cwd) argv.push('-c', cwd);
    argv.push(...command);
    for (const setting of SETTINGS) argv.push(';', ...setting);
    return argv;
}

export function killCommand(name) {
    if (!isConversationName(name)) throw new Error('not a conversation name');
    return ['tmux', '-L', SOCKET, 'kill-session', '-t', `=${name}`];
}
