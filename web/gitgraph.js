/* THE BRANCH DIAGRAM of a repository: its last commits, one per row, newest
   on top, each branch a coloured line, as `git log --graph` lays them out.
   Drawn here in SVG, by hand (no library): what the agent wrote (subjects,
   branch names) is only ever set as text, never parsed as markup.
   `layout` is pure (tested in test/gitgraph.test.mjs); `draw` makes the
   element, each row a button that opens the review of that commit. */
(() => {
    const ROW = 30; const LANE = 16; const PAD = 10;
    /* commits: [{id, parents: [id]}], newest first in topological order.
       -> { rows: [{id, col}], edges: [{from: row, to: row | null, fromCol,
       toCol, kind: 'straight'|'fork'|'merge'}], cols }. A parent not in the
       list (older than what is drawn) is an edge to the bottom (to: null). */
    function layout(commits) {
        const lanes = [];
        const rows = []; const at = new Map();
        const free = () => { const i = lanes.indexOf(null); return i >= 0 ? i : lanes.push(null) - 1; };
        const pending = [];
        commits.forEach((c, row) => {
            let col = lanes.indexOf(c.id);
            if (col < 0) col = free();
            /* Every other lane that waited for this commit ends here. */
            for (let j = 0; j < lanes.length; j++) if (j !== col && lanes[j] === c.id) lanes[j] = null;
            rows.push({ id: c.id, col }); at.set(c.id, row);
            const parents = c.parents ?? [];
            lanes[col] = parents[0] ?? null;
            parents.forEach((p, k) => {
                if (k === 0) { pending.push({ from: row, parent: p, fromCol: col, first: true }); return; }
                let lane = lanes.indexOf(p);
                if (lane < 0) { lane = free(); lanes[lane] = p; }
                pending.push({ from: row, parent: p, fromCol: col, laneCol: lane, first: false });
            });
            while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
        });
        const edges = pending.map((e) => {
            const to = at.has(e.parent) ? at.get(e.parent) : null;
            const toCol = to === null ? (e.first ? e.fromCol : e.laneCol) : rows[to].col;
            const kind = toCol === e.fromCol ? 'straight' : e.first ? 'fork' : 'merge';
            return { from: e.from, to, fromCol: e.fromCol, toCol, kind };
        });
        const cols = Math.max(1, ...rows.map((r) => r.col + 1), ...edges.map((e) => e.toCol + 1));
        return { rows, edges, cols };
    }

    /* "08:12" today, "yesterday", else "15 Oct". */
    function when(iso, now = new Date()) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const days = Math.round((day(now) - day(d)) / 86_400_000);
        if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (days === 1) return 'yesterday';
        return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    }

    /* How far the agent's branch is ahead of or behind the remote's, for a
       branch that both carry at different commits: counted among the commits
       drawn (a parent older than the diagram stops the walk). -> { name:
       { ahead, behind } }. */
    function syncCounts(commits) {
        const parents = new Map((commits ?? []).map((c) => [c.id, c.parents ?? []]));
        const reach = (start) => { const seen = new Set(); const stack = [start]; while (stack.length) { const x = stack.pop(); if (seen.has(x) || !parents.has(x)) continue; seen.add(x); for (const p of parents.get(x)) stack.push(p); } return seen; };
        const tips = {};
        for (const c of commits ?? []) for (const ref of c.refs ?? []) (tips[ref.name] ??= {})[ref.side] = c.id;
        const out = {};
        for (const [name, t] of Object.entries(tips)) {
            if (!t.agent || !t.remote || t.agent === t.remote) continue;
            const a = reach(t.agent); const r = reach(t.remote);
            let ahead = 0; let behind = 0;
            for (const x of a) if (!r.has(x)) ahead++;
            for (const x of r) if (!a.has(x)) behind++;
            out[name] = { ahead, behind };
        }
        return out;
    }

    const NS = 'http://www.w3.org/2000/svg';
    /* graph: what /api/git/<name>/graph answers. pick(commit): a row was chosen. */
    function draw(graph, { pick, now } = {}) {
        const commits = graph?.commits ?? [];
        const box = document.createElement('div'); box.className = 'gg';
        if (commits.length === 0) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Nothing committed yet.'; box.append(p); return box; }
        const counts = syncCounts(commits);
        /* By default a row shows its message, who committed it, and its branches.
           One click brings in the id, the time and the ahead/behind count; the
           choice is not kept -- it is only how this diagram is being looked at. */
        const wrap = document.createElement('div'); wrap.className = 'gg-wrap';
        const bar = document.createElement('div'); bar.className = 'gg-bar';
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'gg-toggle'; toggle.textContent = 'Détails'; toggle.setAttribute('aria-pressed', 'false');
        toggle.addEventListener('click', () => toggle.setAttribute('aria-pressed', box.classList.toggle('gg-detailed') ? 'true' : 'false'));
        bar.append(toggle);
        const { rows, edges, cols } = layout(commits);
        const width = PAD * 2 + (cols - 1) * LANE; const height = rows.length * ROW;
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'gg-lines'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('aria-hidden', 'true');
        const x = (col) => PAD + col * LANE; const y = (row) => row * ROW + ROW / 2;
        const colour = (col) => `var(--gg-${col % 6})`;
        for (const e of edges) {
            const path = document.createElementNS(NS, 'path');
            const x1 = x(e.fromCol); const y1 = y(e.from); const x2 = x(e.toCol);
            const y2 = e.to === null ? height : y(e.to);
            let d;
            if (e.kind === 'straight') d = `M${x1} ${y1} L${x2} ${y2}`;
            /* A branch that left from its parent: down its own lane, then a curve into the parent. */
            else if (e.kind === 'fork') { const bend = Math.max(y1, y2 - ROW); d = `M${x1} ${y1} L${x1} ${bend} C${x1} ${bend + ROW / 2} ${x2} ${bend + ROW / 2} ${x2} ${y2}`; }
            /* A merge: a curve out to the other parent's lane, then down it. */
            else { const bend = Math.min(y2, y1 + ROW); d = `M${x1} ${y1} C${x1} ${y1 + ROW / 2} ${x2} ${bend - ROW / 2} ${x2} ${bend} L${x2} ${y2}`; }
            path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '2.5');
            path.setAttribute('stroke', colour(e.kind === 'merge' ? e.toCol : e.fromCol));
            if (e.to === null) path.setAttribute('stroke-dasharray', '3 4');
            svg.append(path);
        }
        rows.forEach((r, i) => {
            const c = commits[i];
            const dot = document.createElementNS(NS, 'circle');
            dot.setAttribute('cx', String(x(r.col))); dot.setAttribute('cy', String(y(i))); dot.setAttribute('r', '5.5');
            const head = (c.refs ?? []).some((ref) => ref.side === 'agent');
            dot.setAttribute('fill', head && i === 0 ? 'var(--panel)' : colour(r.col)); dot.setAttribute('stroke', colour(r.col)); dot.setAttribute('stroke-width', '2.5');
            svg.append(dot);
        });
        const list = document.createElement('div'); list.className = 'gg-rows';
        list.style.paddingLeft = `${width + 6}px`;
        rows.forEach((r, i) => {
            const c = commits[i];
            const b = document.createElement('button'); b.type = 'button'; b.className = 'gg-row'; b.dataset.id = c.id;
            b.title = `Open the review of ${c.id.slice(0, 7)}`;
            /* Fixed columns, so the author, the time and the branches line up
               down the rows and read at a glance. All set as text, never markup. */
            const cell = (cls, tag, text) => { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; };
            /* The message takes all the room it can and is cut only when it must;
               the other columns are a fixed block on the right. */
            const subject = cell('gg-subject', 'span', c.subject || '(no message)'); subject.title = c.subject || '';
            const meta = document.createElement('div'); meta.className = 'gg-meta';
            const author = cell('gg-author', 'span', c.author || '');
            const time = cell('gg-time', 'small', when(c.date, now));
            const sha = cell('gg-id', 'small', c.id.slice(0, 7));
            const refs = document.createElement('div'); refs.className = 'gg-refs';
            /* Its branches: the agent's (filled), the remote's (outlined); the same name on both is one label. */
            const names = new Map();
            for (const ref of c.refs ?? []) names.set(ref.name, names.has(ref.name) && names.get(ref.name) !== ref.side ? 'both' : ref.side);
            for (const [name, side] of names) {
                const pill = document.createElement('span'); pill.className = `gg-ref gg-${side}`; pill.textContent = name;
                pill.style.setProperty('--c', colour(r.col));
                pill.title = side === 'agent' ? `The agent's ${name}` : side === 'remote' ? `The remote's ${name}` : `${name}, the same here and on the remote`;
                refs.append(pill);
                /* On the agent's tip of a branch that is not level with the remote:
                   how far it is ahead and behind (shown only in the detailed view). */
                const n = side !== 'remote' && counts[name];
                if (n && (n.ahead || n.behind)) {
                    const badge = document.createElement('small'); badge.className = 'gg-count';
                    badge.textContent = `${n.ahead ? `↑${n.ahead}` : ''}${n.behind ? ` ↓${n.behind}` : ''}`.trim();
                    badge.title = `${n.ahead} ahead of, ${n.behind} behind the remote`;
                    refs.append(badge);
                }
            }
            meta.append(author, time, sha, refs);
            b.append(subject, meta);
            if (pick) b.addEventListener('click', () => pick(c));
            list.append(b);
        });
        box.append(svg, list);
        wrap.append(bar, box);
        return wrap;
    }
    globalThis.clavariumGraph = { layout, draw, when, syncCounts };
})();
