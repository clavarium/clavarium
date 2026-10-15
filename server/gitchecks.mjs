/* CHECKS BEFORE SENDING, RUN IN THE AGENT'S MACHINE -- NEVER HERE.
 *
 * Before commits are sent, the owner may want them checked: the project's
 * own pre-push hook, and/or a command of the owner's choosing ("npm test").
 * Both are the PROJECT'S code, written or changed by the tool: run on this
 * server, they would run whatever the tool put there with the server's
 * rights. So they run where the tool already runs anything it likes: in its
 * machine, in its repository, as the tool's own commands would, through the
 * same route that types into its terminal (the host program's `vm exec`).
 *
 * What comes back is said for what it is: the machine says the checks
 * passed. A tool that wanted to could make them pass. It is a safeguard
 * against mistakes, not a proof against a tool that lies; the page says so.
 *
 * The hook is fed what git feeds it on a real push: the remote's name and
 * address as arguments, and on its input one line "<local ref> <local
 * commit> <remote ref> <remote commit>" for the exact commit to send and the
 * exact branch it would go to. They run where that exact commit is checked
 * out: the repository's own folder, or another working tree of it (git
 * worktree), or else a working tree made at that commit for the checks and
 * taken away after them. What was checked is always what would be sent.
 *
 * Bounded: a time limit (killed after it), and only the end of the output
 * comes back.
 */
export const OUTPUT_MAX = 8000;
export const SECONDS_MIN = 10;
export const SECONDS_MAX = 3600;
export const COMMAND_MAX = 500;
const ZERO = '0'.repeat(40);
/* Exit codes of the script below that are not the checks' own. */
const NOT_THERE = 90; const MOVED = 91; const NOTHING = 95; const TIMED_OUT = 124;

/* Runs in the machine, as `sh -c SCRIPT clavarium-check <repo> <head> <line> <url> <command> <hook>`.
   Everything it is given is an argument: nothing is pasted into the script. */
export const SCRIPT = `exec 2>&1
repo="$1"; head="$2"; line="$3"; url="$4"; cmd="$5"; hook="$6"
cd "$repo" 2>/dev/null || { echo "The repository is not at $repo in this machine."; exit ${NOT_THERE}; }
tmp="$(mktemp -d)" || exit 1
made=""
trap '[ -n "$made" ] && git -C "$repo" worktree remove --force "$made" >/dev/null 2>&1; rm -rf "$tmp"' EXIT
now="$(git rev-parse --verify --quiet HEAD)"
where="Checked in $repo."
if [ "$now" != "$head" ]; then
  # The commit may be checked out in another working tree of this repository
  # (git worktree): it is checked there, as it is.
  found="$(git worktree list --porcelain 2>/dev/null | awk -v h="$head" '/^worktree /{w=substr($0,10)} /^HEAD /{if ($2==h) {print w; exit}}')"
  if [ -n "$found" ] && cd "$found" 2>/dev/null; then where="Checked in $found, where this commit is checked out."
  else
    # Nowhere: a working tree of its own, at exactly this commit, made for
    # the checks and taken away after them.
    git cat-file -e "$head^{commit}" 2>/dev/null || { echo "The commit to send ($head) is not in this repository. Look again."; exit ${MOVED}; }
    git worktree add --detach --quiet "$tmp/at" "$head" >/dev/null 2>&1 || { echo "The repository here is at \${now:-no commit}, not at the commit to send ($head), and a working tree at that commit could not be made. Look again."; exit ${MOVED}; }
    made="$tmp/at"; cd "$made" || exit ${MOVED}
    where="Checked in a working tree made at this commit, then taken away."
  fi
fi
[ "$(git rev-parse --verify --quiet HEAD)" = "$head" ] || { echo "What would be checked is not the commit to send ($head). Look again."; exit ${MOVED}; }
status=0; ran=0
{
  echo "$where"
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null | head -1)" ]; then echo "Note: files changed here and not committed are part of what was checked."; fi
  if [ "$hook" = yes ]; then
    path="$(git rev-parse --git-path hooks/pre-push)"
    if [ -x "$path" ]; then
      ran=1; echo "--- pre-push hook"
      printf '%s\\n' "$line" > "$tmp/in"
      if git hook run -h 2>&1 | grep -q to-stdin; then git hook run --to-stdin="$tmp/in" pre-push -- origin "$url" || status=$?
      else "$path" origin "$url" < "$tmp/in" || status=$?; fi
      echo "--- pre-push hook: exit $status"
    else echo "--- no pre-push hook in this repository"; fi
  fi
  if [ "$status" = 0 ] && [ -n "$cmd" ]; then
    ran=1; echo "--- $cmd"
    sh -c "$cmd" < /dev/null || status=$?
    echo "--- exit $status"
  fi
} > "$tmp/out" 2>&1
tail -c ${OUTPUT_MAX} "$tmp/out"
[ "$ran" = 1 ] || exit ${NOTHING}
exit "$status"`;

// eslint-disable-next-line no-control-regex
const printable = (text) => String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '').slice(-OUTPUT_MAX);

export class GitChecks {
    #vms; #conversations; #resources; #now;

    constructor({ vms, conversations, resources, now = () => new Date() }) {
        this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#now = now;
    }

    /* A machine that runs and has the repository attached: one it may write
       in first (it is where the tool works on it). */
    async machineFor(repository) {
        const awake = this.#conversations.awake();
        const holders = awake.map((name) => ({ name, access: this.#resources.of(name).find((r) => r.name === repository)?.access })).filter((h) => h.access);
        holders.sort((a, b) => (a.access === b.access ? 0 : a.access === 'write' ? -1 : 1));
        for (const h of holders) if (await this.#conversations.running(h.name).catch(() => false)) return h.name;
        return undefined;
    }

    /* Does this conversation's machine run, with the repository attached
       for writing? Automatic sending acts for a conversation only then: its
       agent is the one at work in the repository, and its checks run there. */
    async runs(conversation, repository) {
        if (!this.#conversations.awake().includes(conversation)) return false;
        if (this.#resources.of(conversation).find((r) => r.name === repository)?.access !== 'write') return false;
        return Boolean(await this.#conversations.running(conversation).catch(() => false));
    }

    /* -> { status: 'passed' | 'failed' | 'none' | 'unavailable', output, machine, at, head, target }.
       'none': nothing to run (no hook, no command). 'unavailable': no
       machine to run them in, or it did not answer.
       `machine`: the conversation whose machine must run them (automatic
       sending: the one whose settings decided), else any that has it. */
    async run(repository, { head, branch, target, remoteTip, remote, command = '', hook = true, seconds = 600, machine: wanted }) {
        const at = this.#now().toISOString();
        const base = { head, target, at, machine: null };
        if (!hook && !command) return { ...base, status: 'none', output: 'No check is set: no pre-push hook asked for, no check command.' };
        const machine = wanted === undefined ? await this.machineFor(repository) : (await this.runs(wanted, repository) ? wanted : undefined);
        if (!machine) return { ...base, status: 'unavailable', output: 'No machine that has this repository attached is running: the checks could not run. Open a conversation it is attached to, then look again.' };
        const line = `refs/heads/${branch} ${head} refs/heads/${target} ${remoteTip ?? ZERO}`;
        const r = await this.#vms.exec(machine, ['timeout', '-k', '10', String(seconds), 'sh', '-c', SCRIPT, 'clavarium-check', `/resources/${repository}`, head, line, String(remote ?? ''), command, hook ? 'yes' : 'no'],
            { timeoutMs: (seconds + 60) * 1000 }).catch((error) => ({ code: -1, stdout: '', stderr: String(error?.message ?? error) }));
        const output = printable(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim();
        const said = (status, why) => ({ ...base, machine, status, output: why ? `${why}${output ? `\n${output}` : ''}` : output });
        if (r.code === 0) return said('passed');
        if (r.code === NOTHING) return said('none', 'Nothing was checked: this repository has no pre-push hook, and no check command is set.');
        if (r.code === TIMED_OUT || r.code === 137) return said('failed', `Stopped after ${seconds} seconds, the time limit.`);
        if (r.code === NOT_THERE || r.code === MOVED) return said('failed');
        return said('failed', `The checks failed (exit ${r.code}).`);
    }
}
