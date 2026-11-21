# The site's pictures and films, made from code

The new site lives in `docs/preview/` (published at clavarium.org/preview/, not indexed).
Its chat pictures and demo films are never made by hand: they are drawn by the real Parley
chat (the `clavarium-parley` this repository installs) from invented English demo data,
then captured by a browser. Run them again whenever Parley or a demo changes:

    PLAYWRIGHT=/path/to/playwright-core/index.mjs node tools/site/make-shots.mjs   # docs/preview/shots/chat-*.png
    PLAYWRIGHT=/path/to/playwright-core/index.mjs node tools/site/make-demo.mjs    # docs/preview/shots/demo-*.webm (+ posters)
    node tools/site/make-demo.mjs your-ok home                                    # only some films

- `brief.mjs`: the text of the "busy person's daily brief" demo.
- Playwright is not a dependency of Clavarium: give the path of yours (or install playwright-core).
- Invented names and example.com addresses only. Nothing here reads real data.
