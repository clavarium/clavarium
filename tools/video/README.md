# Demo videos

Short films of the real app, each showing one idea, made again in one command at every release. Each film
serves three times: a short on its own (X, Reddit, YouTube Shorts), the film of its page on the site, and a
part of the long explainer on YouTube. The plan of all of them (titles, pages, lengths, priorities) is kept
beside the work: `demos-plan/plan.md`.

## What a demo is

One file in `scenarios/<name>.mjs`:

- `name`, `title`, `page` (the site page it belongs to), `formats` (`desk`, `phone`, or both);
- `tools`: the AIs it shows, as plain shells under the names a reader knows (`tool(id, label)` from `stage.mjs`);
- `lines`: what is said, one take per line, short sentences; `gaps`: the silence before each line;
- `seed(b, me, { bridge })`: the invented world (conversations, files, an agent's words through Parley's
  bridge), with example.com names only and no real data;
- `play(f, cue, ctx)`: the gestures. `f.card(text)` shows a title card, `f.begin()` marks where the film
  starts (what came before is cut), `cue(i)` marks where line *i* is said, `f.tap()` and `f.point()` move a
  visible pointer, `f.spot()` rings what the voice talks about.

The voice follows the picture: a line starts when `cue(i)` is reached, never before the line before it is
done. A slow step makes a longer film, never a voice ahead of the image.

## Making them

    pocket-tts serve --host 127.0.0.1 --port 8765 --language english     # the voice, once
    PLAYWRIGHT=/path/to/playwright-core/index.mjs node tools/video/make.mjs [name ...] [--burn] [--out DIR]

- no name: every scenario; `--burn`: subtitles drawn into the picture (X), else a subtitle track, English,
  on by default; `--out`: where the films go (default `docs/shots`).
- `THEME=dark` films the app in its dark theme (light by default, 26-11: it matches the site and reads better
  once compressed); `VOICE` another Pocket TTS voice (default `alba`); `FFMPEG` the ffmpeg to use.
- Out, per format: `<name>-<format>.mp4` (1920x1080 or 1080x1920), `<name>-<format>.srt`,
  `<name>-<format>-poster.png`.

Each film is played on a fresh end-to-end bench (`e2e/bench.mjs`): the real server, page, API, terminals,
Parley and Tether. The VM manager and the agents are stand-ins, so a film says so on the site
("Demo: invented data, scripted agents").

## At a release

Run `make.mjs` with no name, watch each film once (the pointer lands on what is said, nothing overflows,
subtitles in time), then copy the films to `docs/shots` and the pages pick them up. A scenario that no longer
finds its button fails loudly: fix the scenario, never the film by hand.

## Needs

Playwright (chromium), tmux, ffmpeg with libx264 and libass, Pocket TTS (Kyutai, MIT; voices CC-BY-4.0,
credited in docs/CREDITS).
