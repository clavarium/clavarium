/* claude-pulse CHAT: Claude Code's hooks tell the chat CHAT (a Parley folder)
 * that the agent acts -- before each tool it uses, and when it is woken --
 * and when its turn ends or it waits for the person, so that the person sees "Working..." while it works
 * without a word. Written in ~/.claude/settings.json among the hooks already
 * there, which are kept; ours are known by their command and written again.
 * Written only when it changes, readable by its owner alone. A file that is
 * not a JSON object is not touched (exit 3), like json-set.
 *
 * The hooks never fail, and print nothing but the Stop hook's answer: a
 * hook's output may reach the agent, and a failing one may stop it.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const [chat] = process.argv.slice(2);
if (!chat || !isAbsolute(chat) || !/^[A-Za-z0-9._/-]+$/.test(chat)) { console.error('usage: claude-pulse <the chat folder, a whole path>'); process.exit(64); }
const ours = (end) => `parley pulse${end ? ' --end' : ''} --dir ${chat} >/dev/null 2>&1 || true`;
/* Stopping while its chat still says it works, it is asked once to say where it is: what parley prints
   there is that hook's answer (a decision), so it is not thrown away; it never fails. */
const stopping = `parley pulse --end --stop-check --dir ${chat} 2>/dev/null || true`;
/* Notification: it asks the person in its terminal (leave to act), or waits for them: not working. */
const WANTED = { PreToolUse: ours(false), UserPromptSubmit: ours(false), Stop: stopping, Notification: ours(true) };
const isOurs = (h) => typeof h?.command === 'string' && /^parley pulse\b/.test(h.command);

const at = join(homedir(), '.claude', 'settings.json');
let data = {};
try { data = JSON.parse(readFileSync(at, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') { console.error('claude-pulse: .claude/settings.json is not JSON: left as it is'); process.exit(3); }
}
if (!data || typeof data !== 'object' || Array.isArray(data)) { console.error('claude-pulse: .claude/settings.json is not a JSON object: left as it is'); process.exit(3); }
if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks))) { console.error('claude-pulse: its hooks are not an object: left as they are'); process.exit(3); }
const was = JSON.stringify(data);
const hooks = { ...(data.hooks ?? {}) };
for (const [event, command] of Object.entries(WANTED)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    /* Every other hook kept; a group left empty by taking ours out goes. */
    const others = groups.map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g)).filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    hooks[event] = [...others, { ...(event === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command }] }];
}
data.hooks = hooks;
if (JSON.stringify(data) !== was) {
    mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
    writeFileSync(`${at}.new`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${at}.new`, at);
}
