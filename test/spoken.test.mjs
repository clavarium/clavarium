/* Numbers said in words before the box speaks French (05-11). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenFr, numberFr } from '../server/spoken.mjs';

test('whole numbers in French words', () => {
    assert.equal(numberFr(0), 'zéro'); assert.equal(numberFr(21), 'vingt et un'); assert.equal(numberFr(71), 'soixante et onze');
    assert.equal(numberFr(80), 'quatre-vingts'); assert.equal(numberFr(91), 'quatre-vingt-onze'); assert.equal(numberFr(200), 'deux cents');
    assert.equal(numberFr(2026), 'deux mille vingt-six'); assert.equal(numberFr(21876), 'vingt et un mille huit cent soixante-seize');
    assert.equal(numberFr(1000000), 'un million');
});

test('times, amounts, percentages, decimals and versions are said in words', () => {
    assert.equal(spokenFr('à 22 h 34'), 'à vingt-deux heures trente-quatre');
    assert.equal(spokenFr('Il est 7 h 40.'), 'Il est sept heures quarante.');
    assert.equal(spokenFr('12,02 euros'), 'douze euros deux');
    assert.equal(spokenFr('1 823,03 € par mois'), 'mille huit cent vingt-trois euros trois par mois');
    assert.equal(spokenFr('éveil 94 %'), 'éveil quatre-vingt-quatorze pour cent');
    assert.equal(spokenFr('hausse de 1,18 %'), 'hausse de un virgule dix-huit pour cent');
    assert.equal(spokenFr('la 0.1.51'), 'la zéro point un point cinquante et un');
    assert.equal(spokenFr('99 100'), 'quatre-vingt-dix-neuf cent', 'a plain space separates two numbers');
    assert.equal(spokenFr('Bonjour.'), 'Bonjour.');
});
