/* The relay script, as far as it can be tried without being root. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../deploy/relay.sh', import.meta.url));
const relay = (...args) => { const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const BODY = 'AAAAC3NzaC1lZDI1NTE5AAAAI' + 'A'.repeat(43);
const KEY = `ssh-ed25519 ${BODY} clavarium-tunnel`;

test('with a public key it says what it would do: two ports, nothing seen', () => {
    const r = relay('--key', KEY, '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /443 -> 8443, 80 -> 8080/);
    assert.match(r.out, /sees\s+nothing/);
    assert.equal(relay('--key', `ssh-ed25519 ${BODY}`, '--dry-run').code, 0, 'the name is optional');
    assert.match(r.out, /maintenance none/);
    assert.match(r.out, /updates\s+Ubuntu's security updates, automatic/);
});

test('with a maintenance key it says so; the same key twice, or a bad one, is refused', () => {
    const keeper = `ssh-ed25519 ${'AAAAC3NzaC1lZDI1NTE5AAAAI' + 'K'.repeat(43)} clavarium-keeper`;
    const r = relay('--key', KEY, '--keeper-key', keeper, '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /maintenance clavarium-keeper: may run clavarium-relay, and nothing else/);
    assert.match(r.out, /program\s+clavarium-relay@\S+ from npm, checked/);
    assert.equal(relay('--key', KEY, '--keeper-key', KEY, '--dry-run').code, 64);
    assert.equal(relay('--key', KEY, '--keeper-key', 'ssh-rsa AAAA', '--dry-run').code, 64);
});

test('the key line gives rights: anything but exactly one public key is refused', () => {
    for (const key of [
        '', 'not a key', `ssh-rsa ${BODY}`, `${KEY}\nssh-ed25519 ${BODY} second`,
        `no-pty ${KEY}`, `ssh-ed25519 ${BODY} name" command="id`, `ssh-ed25519 ${BODY} a b`,
        '-----BEGIN OPENSSH PRIVATE KEY-----',
    ]) {
        const r = relay('--key', key, '--dry-run');
        assert.equal(r.code, 64, JSON.stringify(key));
        assert.equal(r.out, '');
    }
    assert.match(relay('--key', '-----BEGIN OPENSSH PRIVATE KEY-----', '--dry-run').err, /must never leave home/);
});

test('the tunnel account is bounded twice: by its key line and by the SSH server (written by the relay program)', () => {
    const text = readFileSync(new URL('../relay/clavarium-relay', import.meta.url), 'utf8');
    assert.match(text, /restrict,port-forwarding,permitlisten=/);
    for (const line of ['AllowTcpForwarding remote', 'PermitOpen none', 'PermitTTY no', 'ForceCommand /bin/false', 'PasswordAuthentication no']) assert.ok(text.includes(line), line);
});
