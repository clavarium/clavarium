/* The branch diagram's layout (web/gitgraph.js): lanes as `git log --graph` draws them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../web/gitgraph.js';

const { layout, when } = globalThis.clavariumGraph;

test('one branch is one straight lane; the oldest commit drawn goes on down when its parent is not drawn', () => {
    const g = layout([{ id: 'c', parents: ['b'] }, { id: 'b', parents: ['a'] }, { id: 'a', parents: ['z'] }]);
    assert.deepEqual(g.rows.map((r) => r.col), [0, 0, 0]);
    assert.deepEqual(g.edges.map((e) => [e.from, e.to, e.kind]), [[0, 1, 'straight'], [1, 2, 'straight'], [2, null, 'straight']]);
    assert.equal(g.cols, 1);
});

test('a branch that left main takes a lane of its own, and its merge comes back to main', () => {
    /* m2 merges dev (d1) into main; dev left main at m0. */
    const g = layout([
        { id: 'm2', parents: ['m1', 'd1'] },
        { id: 'd1', parents: ['m0'] },
        { id: 'm1', parents: ['m0'] },
        { id: 'm0', parents: [] },
    ]);
    assert.deepEqual(g.rows.map((r) => [r.id, r.col]), [['m2', 0], ['d1', 1], ['m1', 0], ['m0', 0]]);
    const kinds = Object.fromEntries(g.edges.map((e) => [`${g.rows[e.from].id}>${e.to === null ? '' : g.rows[e.to].id}`, e.kind]));
    assert.deepEqual(kinds, { 'm2>m1': 'straight', 'm2>d1': 'merge', 'd1>m0': 'fork', 'm1>m0': 'straight' });
    assert.equal(g.cols, 2);
});

test('two branch tips side by side, each on its lane, meeting at their common parent', () => {
    const g = layout([{ id: 'dev', parents: ['base'] }, { id: 'main', parents: ['base'] }, { id: 'base', parents: [] }]);
    assert.deepEqual(g.rows.map((r) => r.col), [0, 1, 0]);
    assert.deepEqual(g.edges.map((e) => e.kind), ['straight', 'fork']);
});

test('a row shows who committed it, with the short id and the date', () => {
    /* The smallest document draw() needs: elements that keep their text and children. */
    class Node { constructor() { this.childNodes = []; } append(...k) { for (const c of k) this.childNodes.push(c); }
        setAttribute() {} setAttributeNS() {} addEventListener() {} set className(v) { this._c = v; } get className() { return this._c ?? ''; }
        set textContent(t) { this.childNodes = [{ textContent: String(t) }]; } get textContent() { return this.childNodes.map((c) => c.textContent ?? '').join(''); }
        set title(t) { this._t = t; } set type(t) {} set style(v) {} get style() { return { setProperty() {} }; } get dataset() { return this._d ?? (this._d = {}); } }
    const was = { document: globalThis.document };
    globalThis.document = { createElement: () => new Node(), createElementNS: () => new Node() };
    try {
        const { draw } = globalThis.clavariumGraph;
        const box = draw({ commits: [{ id: 'abcdef1234567890', parents: [], subject: 'Did a thing', author: 'tuxo83', date: new Date(2026, 9, 18, 8, 12).toISOString(), refs: [] }] }, { now: new Date(2026, 9, 18, 12, 0) });
        const text = box.textContent;
        assert.match(text, /tuxo83/, 'the author is shown');
        assert.match(text, /abcdef1/, 'the short id is shown');
        assert.match(text, /Did a thing/);
        /* No author (older data): the row still draws, with id and date only. */
        const noAuthor = draw({ commits: [{ id: 'abcdef1234567890', parents: [], subject: 's', date: new Date(2026, 9, 18, 8, 12).toISOString(), refs: [] }] }, { now: new Date(2026, 9, 18, 12, 0) });
        assert.match(noAuthor.textContent, /abcdef1/);
    } finally { globalThis.document = was.document; }
});

test('dates read short: the time today, yesterday, else day and month', () => {
    const now = new Date(2026, 9, 18, 12, 0);
    assert.equal(when(new Date(2026, 9, 17, 9, 0).toISOString(), now), 'yesterday');
    assert.match(when(new Date(2026, 9, 18, 8, 12).toISOString(), now), /08.12|8.12/);
    assert.match(when(new Date(2026, 9, 15).toISOString(), now), /15/);
    assert.equal(when('not a date', now), '');
});
