import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vms } from '../server/vm.mjs';


/* A CONVERSATION IN A SHARED MACHINE (#221): its VM operations reach that machine; what is run for it goes through
   its door (clavarium-enter), as root; a conversation of its own, as always. */
test('a shared machine: its operations reach it, its runs go through the door of the conversation', async () => {
    const asked = [];
    const vms = new Vms(async (argv) => { asked.push(argv); return { code: 0, stdout: '', stderr: '' }; }, ['host'], { machineOf: (c) => (c === 'mail' || c === 'diary' ? 'assistants' : undefined) });
    assert.equal(vms.vmOf('mail'), 'clv-assistants');
    assert.equal(vms.vmOf('alone'), 'clv-alone');
    assert.throws(() => vms.vmOf('Bad Name'));
    await vms.exec('mail', ['tmux', 'ls']);
    await vms.exec('alone', ['tmux', 'ls']);
    await vms.stop('diary');
    assert.deepEqual(asked, [
        ['vm', 'exec', 'clv-assistants', '--', 'sudo', '-n', 'clavarium-enter', 'mail', '--', 'tmux', 'ls'],
        ['vm', 'exec', 'clv-alone', '--', 'tmux', 'ls'],
        ['vm', 'stop', 'clv-assistants'],
    ]);
    assert.deepEqual(vms.execArgv('diary', ['bash']), ['host', 'vm', 'exec', 'clv-assistants', '--', 'sudo', '-n', 'clavarium-enter', 'diary', '--', 'bash']);
});

test('a shared machine: its work and its folders go into its own place there, and come out of it', async () => {
    const asked = [];
    const vms = new Vms(async (argv) => { asked.push(argv.join(' ')); return { code: 0, stdout: '', stderr: '' }; }, ['host'], { machineOf: (c) => (c === 'mail' ? 'assistants' : undefined), userOf: (c) => (c === 'mail' ? { uid: 1001, gid: 1001 } : undefined) });
    await vms.workMount('mail', 1000, 1000); await vms.mount('mail', 'folder', 'docs', 1000, 1000); await vms.umount('mail', 'docs'); await vms.workUnmount('mail');
    await vms.workMount('alone', 1000, 1000); await vms.umount('alone', 'docs');
    assert.deepEqual(asked, [
        'vm smount clv-assistants mail work mail 1000 1000 1001 1001', 'vm smount clv-assistants mail folder docs 1000 1000 1001 1001',
        'vm sumount clv-assistants mail docs', 'vm sumount clv-assistants mail work',
        'vm mount clv-alone work alone 1000 1000', 'vm umount clv-alone docs',
    ]);
});
