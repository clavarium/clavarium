/* SECRETS HANDED TO A TOOL.
 *
 * Some tools need a key to run. Such a secret is attached to a conversation
 * and arrives in its VM two ways at once:
 *   - a file in memory, /run/secrets/<NAME>, gone when the VM stops;
 *   - a variable of the tool's own process, <NAME>.
 *
 * HOW IT TRAVELS: sealed on the host; opened only at the moment of delivery;
 * sent on the STANDARD INPUT of the command that writes it. Never in an
 * argument list -- arguments show in process lists, here and in the VM --
 * never on a shared folder, never written to the VM's disk by this server,
 * never in a log, never back to a browser: once saved, a value cannot be
 * read again from the page, only replaced.
 *
 * WHAT IT IS NOT: protected from the tool. The agent is root in its VM and
 * can read and send anywhere whatever is delivered there. A secret the host
 * should use on the agent's behalf (a push key, a mailbox password) does not
 * belong here, and never enters a VM.
 */
import { Refusal } from './conversations.mjs';
import { Grants, conversationSubject } from './grants.mjs';
import { isConversationName } from './names.mjs';
import { VM_USER } from './vm.mjs';

export const SECRETS_DIR = '/run/secrets';
export const RUNNER = '/usr/local/bin/clv-run';
export const VALUE_MAX = 8 * 1024;
const NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
/* Names the tool's own start depends on must not be replaced by a secret. */
const RESERVED = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'PWD', 'IFS', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);

export const isSecretName = (name) => typeof name === 'string' && NAME.test(name) && !RESERVED.has(name);

/* The tool is started THROUGH this, inside the VM: it turns each delivered
   file into a variable, then BECOMES the tool (exec): no shell stays behind
   it. Written to the VM by this server at each opening. */
export const RUNNER_SCRIPT = `#!/bin/sh
# Written by the host. Exports each delivered secret, then becomes the tool.
for f in ${SECRETS_DIR}/*; do
  n=$(basename "$f")
  # Only what is named like a variable: anything else left there is ignored.
  case "$n" in *[!A-Z0-9_]*|[!A-Z]*) continue ;; esac
  [ -f "$f" ] && export "$n=$(cat "$f")"
done
exec "$@"
`;

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Secrets {
    #store; #vault; #vms; #grants;

    /* `grants`: the one table of rights. "Handed to a conversation" is a
       line of it: the conversation may USE the secret. */
    constructor({ store, vault, vms, grants = new Grants() }) {
        this.#store = store; this.#vault = vault; this.#vms = vms; this.#grants = grants;
        for (const s of store.all()) {
            if (s.attachments === undefined) continue;
            for (const conversation of Object.keys(s.attachments)) this.#grants.give(conversationSubject(conversation), `secret:${s.name}`, 'x');
            delete s.attachments; store.put(s);
        }
    }
    #handed(conversation, name) { return this.#grants.can(conversationSubject(conversation), `secret:${name}`, 'x'); }

    /* Names and where they are attached. Never a value. */
    list() { return this.#store.all().map(({ name, createdAt }) => ({ name, conversations: this.#grants.on(`secret:${name}`).map((g) => g.subject.slice('conversation:'.length)), createdAt })); }
    of(conversation) { return this.#store.all().filter((s) => this.#handed(conversation, s.name)).map((s) => s.name); }

    /* The value, for this server's own use only (the key of the dictation
       engine, put in a request's header): never returned by any route. */
    reveal(name) { const s = this.#store.get(name); return s ? this.#vault.open(s.sealed) : undefined; }

    /* Creates, or replaces the value of, a secret. */
    set({ name, value }) {
        if (!isSecretName(name)) throw new Refusal(400, 'A secret is named like a variable: capitals, digits and underscores, starting with a letter.');
        if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > VALUE_MAX) throw new Refusal(400, `A value is between 1 byte and ${VALUE_MAX / 1024} KB.`);
        if (value.includes('\0')) throw new Refusal(400, 'A value cannot contain a null byte.');
        const before = this.#store.get(name);
        this.#store.put({ name, sealed: this.#vault.seal(value), createdAt: before?.createdAt ?? new Date().toISOString() });
        return { name };
    }

    remove(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such secret.');
        this.#store.remove(name);
        this.#grants.forgetAsset(`secret:${name}`);
    }

    attach(conversation, name, attached) {
        const secret = this.#store.get(name);
        if (!secret) throw new Refusal(404, 'No such secret.');
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        if (attached) this.#grants.give(conversationSubject(conversation), `secret:${name}`, 'x'); else this.#grants.take(conversationSubject(conversation), `secret:${name}`);
    }

    forget(conversation) {
        for (const s of this.#store.all()) this.#grants.take(conversationSubject(conversation), `secret:${s.name}`);
    }

    /* What a delivery to this conversation would contain, as one string that
       changes whenever a delivery would differ: names and sealed values. */
    signature(conversation) {
        return this.#store.all().filter((s) => this.#handed(conversation, s.name)).map((s) => `${s.name}=${s.sealed}`).sort().join('|');
    }

    /* Puts in the VM exactly the secrets attached NOW, and the runner. Called
       each time the conversation is opened: a detached secret disappears from
       the VM, a new one appears, and a restarted VM gets them back. */
    async deliver(conversation) {
        const run = async (argv, input) => {
            const r = await this.#vms.exec(conversation, argv, { input });
            if (r.code !== 0) throw new Refusal(502, `The machine could not be prepared: ${firstLine(r.stderr)}`);
        };
        await run(['sudo', '-n', 'install', '-m', '0755', '/dev/stdin', RUNNER], RUNNER_SCRIPT);
        await run(['sudo', '-n', 'install', '-d', '-m', '0755', SECRETS_DIR]);
        await run(['sudo', '-n', 'find', SECRETS_DIR, '-mindepth', '1', '-delete']);
        for (const secret of this.#store.all()) {
            if (!this.#handed(conversation, secret.name)) continue;
            await run(['sudo', '-n', 'install', '-m', '0600', '-o', VM_USER, '-g', VM_USER, '/dev/stdin', `${SECRETS_DIR}/${secret.name}`], this.#vault.open(secret.sealed));
        }
    }
}
