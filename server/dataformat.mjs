/* THE FORMAT OF THE DATA, AS A NUMBER, and the migrations from one to the next.
 *
 * The number this code writes is in package.json ("clavarium": {"dataFormat"}),
 * so that the updater can read it in a release before running it
 * (deploy/updater.mjs: going back to a release that cannot read the data is
 * refused). The data directory says which format it is in: data-format.json.
 *
 * At each start, before anything reads the data:
 *   - none yet: an existing data directory is format 1 (the first one), a new
 *     one is the current format;
 *   - older: each migration from there runs in order, then the number is
 *     written. A backup was made just before by the updater (backup.sh);
 *   - newer: this code does not know it. It refuses to start, and says how
 *     to go back, rather than read what it does not understand.
 *
 * A migration is `MIGRATIONS[n](dataDir)`: from format n to n + 1, on files
 * of the data directory, idempotent (a start cut short runs it again).
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_FORMAT = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).clavarium?.dataFormat ?? 1;
export const FORMAT_FILE = 'data-format.json';

/* None yet: format 1 is the only one. The next one adds its step here. */
export const MIGRATIONS = {};

export function dataFormat(dataDir) {
    try { return JSON.parse(readFileSync(join(dataDir, FORMAT_FILE), 'utf8')).format; } catch { return undefined; }
}

/* Returns { from, to, ran }: the format found, the one written, the steps run. */
export function migrateData(dataDir, { format = DATA_FORMAT, migrations = MIGRATIONS } = {}) {
    let found = dataFormat(dataDir);
    if (found === undefined) {
        let existing = false;
        try { existing = readdirSync(dataDir).some((f) => f.endsWith('.json')); } catch { /* a new directory */ }
        found = existing ? 1 : format;
    }
    if (!Number.isInteger(found) || found < 1) throw new Error(`${join(dataDir, FORMAT_FILE)} does not hold a format number`);
    if (found > format) throw new Error(`The data in ${dataDir} is in format ${found}, written by a newer Clavarium; this one reads format ${format} at most. Go back to the newer version (Settings, Updates; or deploy/updater.mjs), or restore the backup made before the update.`);
    const ran = [];
    for (let n = found; n < format; n += 1) {
        const step = migrations[n];
        if (!step) throw new Error(`No migration from data format ${n} to ${n + 1}`);
        step(dataDir);
        ran.push(n);
        write(dataDir, n + 1);
    }
    if (dataFormat(dataDir) !== format) write(dataDir, format);
    return { from: found, to: format, ran };
}

function write(dataDir, format) {
    const file = join(dataDir, FORMAT_FILE);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ format })}\n`);
    renameSync(`${file}.tmp`, file);
}
