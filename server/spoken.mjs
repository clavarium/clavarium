/* NUMBERS SAID IN WORDS (05-11): the box's voice read digits in the middle of a French sentence badly
 * (« 22 h 34 », « 12,02 € » came out unintelligible). Before a French text is spoken, its times, amounts,
 * decimals, percentages, versions and whole numbers are written in words. Only French: other languages
 * are left as they are. */

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = { 20: 'vingt', 30: 'trente', 40: 'quarante', 50: 'cinquante', 60: 'soixante' };

function below100(n) {
    if (n <= 16) return UNITS[n];
    if (n < 20) return `dix-${UNITS[n - 10]}`;
    if (n < 70) { const t = Math.floor(n / 10) * 10, u = n % 10; return u === 0 ? TENS[t] : u === 1 ? `${TENS[t]} et un` : `${TENS[t]}-${UNITS[u]}`; }
    if (n < 80) { const u = n - 60; return u === 11 ? 'soixante et onze' : `soixante-${below100(u)}`; }
    const u = n - 80;
    return u === 0 ? 'quatre-vingts' : `quatre-vingt-${below100(u)}`;
}
function below1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    if (h === 0) return below100(r);
    const head = h === 1 ? 'cent' : `${UNITS[h]} cent${r === 0 ? 's' : ''}`;
    return r === 0 ? head : `${head} ${below100(r)}`;
}
/* A whole number in French words, 0 to 999 999 999 999. */
export function numberFr(n) {
    n = Math.floor(Number(n));
    if (!Number.isFinite(n) || n < 0 || n > 999_999_999_999) return String(n);
    if (n < 1000) return below1000(n);
    const parts = [];
    for (const [size, one, many] of [[1e9, 'un milliard', 'milliards'], [1e6, 'un million', 'millions'], [1e3, 'mille', 'mille']]) {
        const q = Math.floor(n / size); n %= size;
        if (q === 0) continue;
        if (q === 1) parts.push(one);
        else { let w = below1000(q); if (size === 1e3) w = w.replace(/cents$/, 'cent').replace(/vingts$/, 'vingt'); parts.push(`${w} ${many}`); }
    }
    if (n) parts.push(below1000(n));
    return parts.join(' ');
}
/* Digits after a decimal comma, said as a number unless it starts with zeros (« zéro deux »). */
const fraction = (d) => (/^0/.test(d) ? [...d].map((c) => UNITS[c]).join(' ') : numberFr(Number(d)));
const whole = (s) => numberFr(Number(String(s).replace(/[\s  .]/g, '')));

export function spokenFr(text) {
    let t = String(text ?? '');
    /* Versions and dotted numbers: 0.1.51 */
    t = t.replace(/\b(\d+)\.(\d+)\.(\d+)\b/g, (_, a, b, c) => `${numberFr(a)} point ${numberFr(b)} point ${numberFr(c)}`);
    /* Times: 22 h 34, 22h34, 22:34, 7 h */
    t = t.replace(/\b([01]?\d|2[0-3])\s?(?:h|:)\s?([0-5]\d)\b/g, (_, h, m) => `${numberFr(h)} heure${Number(h) > 1 ? 's' : ''} ${Number(m) ? numberFr(m) : ''}`.trim());
    t = t.replace(/\b([01]?\d|2[0-3])\s?h\b/g, (_, h) => `${numberFr(h)} heure${Number(h) > 1 ? 's' : ''}`);
    /* Amounts: 1 823,03 €, 12,02 euros, 15 € */
    t = t.replace(/\b(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d{1,2}))?[   ]?(?:€|euros?\b)/g, (_, e, c) => `${whole(e)} euro${whole(e) === 'un' ? '' : 's'}${c && Number(c.padEnd(2, '0')) ? ` ${numberFr(Number(c.padEnd(2, '0')))}` : ''}`);
    t = t.replace(/(\d)\s?€/g, '$1 euros');
    /* Percentages: 94 %, 1,18 % */
    t = t.replace(/\b(\d+)(?:,(\d+))?\s?%/g, (_, i, d) => `${numberFr(i)}${d ? ` virgule ${fraction(d)}` : ''} pour cent`);
    /* Decimals: 12,02 */
    t = t.replace(/\b(\d+),(\d+)\b/g, (_, i, d) => `${numberFr(i)} virgule ${fraction(d)}`);
    /* Whole numbers with a non-breaking or thin space between thousands (21 876); a plain space is left alone (« 99 100 » may be two numbers). */
    t = t.replace(/\b\d{1,3}(?:[  ]\d{3})+\b/g, (s) => whole(s));
    t = t.replace(/\b\d+\b/g, (s) => numberFr(s));
    return t.replace(/\s{2,}/g, ' ');
}
