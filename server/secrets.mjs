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
    #store; #vault; #vms;

    constructor({ store, vault, vms }) { this.#store = store; this.#vault = vault; this.#vms = vms; }

    /* Names and where they are attached. Never a value. */
    list() { return this.#store.all().map(({ name, attachments, createdAt }) => ({ name, conversations: Object.keys(attachments ?? {}), createdAt })); }
    of(conversation) { return this.#store.all().filter((s) => s.attachments?.[conversation]).map((s) => s.name); }

    /* Creates, or replaces the value of, a secret. */
    set({ name, value }) {
        if (!isSecretName(name)) throw new Refusal(400, 'A secret is named like a variable: capitals, digits and underscores, starting with a letter.');
        if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > VALUE_MAX) throw new Refusal(400, `A value is between 1 byte and ${VALUE_MAX / 1024} KB.`);
        if (value.includes('\0')) throw new Refusal(400, 'A value cannot contain a null byte.');
        const before = this.#store.get(name);
        this.#store.put({ name, sealed: this.#vault.seal(value), attachments: before?.attachments ?? {}, createdAt: before?.createdAt ?? new Date().toISOString() });
        return { name };
    }

    remove(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such secret.');
        this.#store.remove(name);
    }

    attach(conversation, name, attached) {
        const secret = this.#store.get(name);
        if (!secret) throw new Refusal(404, 'No such secret.');
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        if (attached) secret.attachments[conversation] = true; else delete secret.attachments[conversation];
        this.#store.put(secret);
    }

    forget(conversation) {
        for (const s of this.#store.all()) if (s.attachments?.[conversation]) { delete s.attachments[conversation]; this.#store.put(s); }
    }

    /* What a delivery to this conversation would contain, as one string that
       changes whenever a delivery would differ: names and sealed values. */
    signature(conversation) {
        return this.#store.all().filter((s) => s.attachments?.[conversation]).map((s) => `${s.name}=${s.sealed}`).sort().join('|');
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
            if (!secret.attachments?.[conversation]) continue;
            await run(['sudo', '-n', 'install', '-m', '0600', '-o', VM_USER, '-g', VM_USER, '/dev/stdin', `${SECRETS_DIR}/${secret.name}`], this.#vault.open(secret.sealed));
        }
    }
}
