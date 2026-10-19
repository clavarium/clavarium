/* THE NAME OF THIS CLAVARIUM: in the title of its tab, above its list, in
 * its alerts, and under its icon once installed. Drawn from its address
 * (clav.example.com -> Clav; "Clavarium" with none), given at the install
 * (--name), changed in Settings. The manifest is made here, from the one in
 * web/, with that name -- or, for one device, the name chosen there when
 * installing (a parameter of the manifest's address: nothing is kept). */
import { readFileSync } from 'node:fs';
import { JsonFile } from './store.mjs';
import { appNameFrom, appNameProblem, shortAppName } from './names.mjs';
import { Refusal } from './conversations.mjs';

const TEMPLATE = JSON.parse(readFileSync(new URL('../web/manifest.webmanifest', import.meta.url), 'utf8'));

export class Instance {
    #file; #fallback;
    constructor({ file = new JsonFile(undefined, {}), origin, given } = {}) {
        this.#file = file;
        this.#fallback = given && !appNameProblem(given) ? given : appNameFrom(origin);
    }
    name() { const kept = this.#file.get().name; return typeof kept === 'string' && !appNameProblem(kept) ? kept : this.#fallback; }
    about() { return { name: this.name(), defaultName: this.#fallback, given: this.name() !== this.#fallback }; }
    /* '' gives back the name drawn from the address. */
    setName(name) {
        if (typeof name !== 'string') throw new Refusal(400, 'Give a name, or nothing for the usual one.');
        const said = name.trim();
        if (said) { const problem = appNameProblem(said); if (problem) throw new Refusal(400, problem); }
        this.#file.set(said && said !== this.#fallback ? { name: said } : {});
        return this.about();
    }
    /* The manifest, as JSON; `asked`: the name one device chose, used only when it is a name. */
    manifest(asked) {
        const name = typeof asked === 'string' && asked && !appNameProblem(asked) ? asked : this.name();
        return JSON.stringify({ ...TEMPLATE, name, short_name: shortAppName(name) }, null, 2);
    }
}
