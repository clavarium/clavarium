/* json-set FILE KEYS: sets KEYS (a JSON object; null takes a key out) in the
 * JSON file FILE of the home, every other key kept. Written only when it
 * changes, readable by its owner alone. A file that is not a JSON object is
 * not touched (exit 3): a person's settings are never overwritten by a guess.
 *
 * Generic: any launcher of /tools/launch may use it for its tool's settings.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const [file, given] = process.argv.slice(2);
if (!file || !given || isAbsolute(file) || file.split('/').includes('..')) { console.error('usage: json-set <file in the home> <keys as JSON>'); process.exit(64); }
let keys;
try { keys = JSON.parse(given); } catch { console.error('json-set: the keys are not JSON'); process.exit(64); }
if (!keys || typeof keys !== 'object' || Array.isArray(keys)) { console.error('json-set: the keys are a JSON object'); process.exit(64); }
const at = join(homedir(), file);
let data = {};
try { data = JSON.parse(readFileSync(at, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') { console.error(`json-set: ${file} is not JSON: left as it is`); process.exit(3); }
}
if (!data || typeof data !== 'object' || Array.isArray(data)) { console.error(`json-set: ${file} is not a JSON object: left as it is`); process.exit(3); }
const was = JSON.stringify(data);
for (const [k, v] of Object.entries(keys)) { if (v === null) delete data[k]; else data[k] = v; }
if (JSON.stringify(data) !== was) {
    mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
    writeFileSync(`${at}.new`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${at}.new`, at);
}
