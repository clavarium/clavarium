/* A CONVERSATION NAME REACHES A COMMAND LINE: it becomes the tmux session
   name, and later the VM name. It is the only operator-chosen value that does,
   so it is validated here, strictly, and nowhere else. Lower-case letters,
   digits and hyphens; starts with a letter; no trailing hyphen. */
export const NAME_MAX = 32;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isConversationName(value) {
    return typeof value === 'string' && value.length <= NAME_MAX && NAME.test(value);
}

/* THE NAME A PERSON READS is free: spaces, capitals, accents, emoji. It never
   reaches a command line (the identifier above does), and the page shows it
   as text only. Refused: what cannot be seen or reorders what is seen
   (control characters, line breaks, zero-width and bidirectional marks), and
   spaces at either end, which would make two names look alike. */
export const TITLE_MAX = 60;
const UNSEEN_RANGES = [[0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const UNSEEN = new RegExp(`[${UNSEEN_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`, 'u');

/* The reason it is refused, or '' when it may be a name. */
export function titleProblem(value) {
    if (typeof value !== 'string' || value === '') return 'Give a name.';
    if (UNSEEN.test(value)) return 'A name has no line breaks and no invisible or direction characters.';
    if (value.trim() !== value) return 'A name does not start or end with a space.';
    if ([...value].length > TITLE_MAX) return `A name is ${TITLE_MAX} characters at most.`;
    return '';
}

/* The identifier drawn from a name: "Location voiture" -> location-voiture;
   one taken -> location-voiture-2. `taken(id)` says whether it is. */
export function identifierFrom(title, taken = () => false) {
    let base = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
    if (!base) base = 'conversation';
    for (let n = 1; ; n += 1) {
        const tail = n === 1 ? '' : `-${n}`;
        const id = `${base.slice(0, NAME_MAX - tail.length).replace(/-+$/, '')}${tail}`;
        if (isConversationName(id) && !taken(id)) return id;
    }
}

/* A FOLDER of the list, and the name of this Clavarium, are names a person
   reads too: the same rules, in their own words. '' is no folder. */
export const GROUP_MAX = 40;
export function groupProblem(value) {
    if (typeof value !== 'string') return 'Give a folder name, or nothing for none.';
    if (value === '') return '';
    const problem = titleProblem(value);
    if (problem) return problem.replace('A name', 'A folder name');
    if ([...value].length > GROUP_MAX) return `A folder name is ${GROUP_MAX} characters at most.`;
    return '';
}
export const APP_NAME_MAX = 30;
export function appNameProblem(value) {
    const problem = titleProblem(value);
    if (problem) return problem;
    if ([...value].length > APP_NAME_MAX) return `A name is ${APP_NAME_MAX} characters at most.`;
    return '';
}
/* The name drawn from an address: clav.example.com -> Clav; none -> Clavarium. */
export function appNameFrom(origin) {
    let host = '';
    try { host = origin ? new URL(origin).hostname : ''; } catch { host = ''; }
    const first = host.split('.')[0] ?? '';
    if (!/^[a-z][a-z0-9-]*$/i.test(first) || /^\d/.test(host) || host === 'localhost') return 'Clavarium';
    return (first.charAt(0).toUpperCase() + first.slice(1)).slice(0, APP_NAME_MAX);
}
/* The short name under an icon: the name when it fits, else its first word, else its start. */
export function shortAppName(name) {
    const chars = [...name];
    if (chars.length <= 12) return name;
    const word = name.split(' ')[0];
    if ([...word].length <= 12) return word;
    return chars.slice(0, 12).join('').trim();
}
