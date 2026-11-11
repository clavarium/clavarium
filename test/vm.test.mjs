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
