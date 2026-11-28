/* A trim says in the log what it gave back and how long it took (Multipass #5617: real figures of real use). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vms } from '../server/vm.mjs';

test('a trim logs the space given back and its time; a failed one logs nothing', async () => {
    let t = 1000; const lines = []; const asked = [];
    const out = '/boot/efi: 98.2 MiB (102983680 bytes) trimmed on /dev/sda15\n/: 2.9 GiB (3137392640 bytes) trimmed on /dev/sda1\n';
    let code = 0;
    const vms = new Vms(async (argv) => { asked.push(argv.join(' ')); t += 3800; return { code, stdout: code ? '' : out, stderr: '' }; }, [], { now: () => t, log: (l) => lines.push(l) });
    await vms.trim('demo');
    assert.deepEqual(asked, ['vm exec clv-demo -- sudo -n fstrim --all --verbose']);
    assert.deepEqual(lines, ['trim clv-demo: 3090 MB given back in 3.8 s']);
    code = 1;
    await vms.trim('demo');
    assert.equal(lines.length, 1);
});
