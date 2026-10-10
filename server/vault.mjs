/* THE VAULT: secrets sealed at rest.
 *
 * One key, in one file readable by this server's account only. What is
 * written to the data files is sealed with it (AES-256-GCM): a copy of the
 * data without the key file shows names and nothing else.
 *
 * The key file is NOT part of the data and should not be backed up next to
 * it: whoever holds both holds everything.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

export class Vault {
    #key;

    constructor(keyPath) {
        if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
        chmodSync(keyPath, 0o600);
        this.#key = readFileSync(keyPath);
        if (this.#key.length !== 32) throw new Error('the vault key file is not a 32-byte key');
    }

    seal(text) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
        const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    }

    /* Throws if the text was not sealed with this key, or was altered. */
    open(sealed) {
        const raw = Buffer.from(String(sealed), 'base64');
        const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
}
