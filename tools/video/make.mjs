#!/usr/bin/env node
/* DEMO VIDEOS, MADE AGAIN IN ONE COMMAND: each scenario (tools/video/scenarios/<name>.mjs) is voiced, played
 * on the end-to-end bench at each of its formats while the voice is timed, and assembled with its subtitles.
 *
 *   PLAYWRIGHT=/path/playwright-core/index.mjs node tools/video/make.mjs [name ...] [--burn] [--out DIR]
 *
 * Needs: Pocket TTS serving (see voice.mjs), ffmpeg (FFMPEG or on PATH), tmux (the bench).
 * Out, per scenario and format: <out>/<name>-<format>.mp4 (subtitles as a track, English, on by default;
 * --burn: drawn into the picture, for X), <name>.srt, <name>-<format>-poster.png. Default out: docs/shots. */
import { readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync as ls } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { voiceLines, ready } from './voice.mjs';
import { loadBench, filmed, cueing, REPO, FORMATS } from './stage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const burn = args.includes('--burn');
const outAt = args.indexOf('--out');
const OUT = resolve(outAt >= 0 ? args[outAt + 1] : join(REPO, 'docs', 'shots'));
const asked = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const TAIL = 1.4;

const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(x)).padStart(2, '0')},${String(Math.round((x % 1) * 1000)).padStart(3, '0').slice(0, 3)}`; };

/* The colour of a corner of the film at a time (its top-left tenth, averaged): to check what a frame shows. */
function corner(file, at) {
    const r = spawnSync(FFMPEG, ['-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'crop=iw/10:ih/10:0:0,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    return [...(r.stdout ?? [])].slice(0, 3);
}
const CARD = [247, 246, 242];
const isCard = (rgb) => rgb.length === 3 && rgb.every((v, i) => Math.abs(v - CARD[i]) <= 14);

/* The key frames: the first, one in each line (where its words are on screen), the last, side by side in one
   picture, to be looked at before a film is used; and the checks a machine can make: the film opens and ends
   on its card. */
function keyFrames(file, starts, said, total, sheet) {
    const times = [0.05, ...starts.map((s, i) => s + Math.min(1.2, said[i].seconds * 0.6)), Math.max(0, total - 0.3)];
    const dir = mkdtempSync(join(tmpdir(), 'clv-keys-'));
    try {
        times.forEach((t, i) => ffmpeg(['-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=-1:360', join(dir, `k${String(i).padStart(2, '0')}.png`)]));
        ffmpeg(['-framerate', '1', '-i', join(dir, 'k%02d.png'), '-vf', `tile=${times.length}x1:padding=6:color=white`, '-frames:v', '1', sheet]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const problems = [];
    if (!isCard(corner(file, 0.05))) problems.push('the first frame is not the opening card');
    if (!isCard(corner(file, Math.max(0, total - 0.3)))) problems.push('the last frame is not the closing card');
    return problems;
}

function ffmpeg(argv) {
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...argv], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr || r.error}`);
}

async function make(sc, { bench, bridge }) {
    const work = mkdtempSync(join(tmpdir(), `clv-video-${sc.name}-`));
    try {
        /* 1. The voice, then the time of each line. */
        const said = await voiceLines(sc.lines, work);
        mkdirSync(OUT, { recursive: true });
        for (const format of sc.formats) {
            /* 2. Played on a fresh bench, filmed. */
            const after = [];
            const vids = join(work, `rec-${format}`);
            let cut = 0; let starts = []; let total = 0;
            try {
                const b = await bench({ after: (fn) => after.push(fn) }, { tools: sc.tools });
                const setup = await b.person();
                const ctx = { b, bridge, ...(await sc.seed(b, setup, { bridge })) };
                await setup.page.close();
                const f = await filmed(b, format, vids, { opening: sc.opening });
                const cued = cueing(f, said, sc.gaps);
                await sc.play(f, cued.cue, ctx);
                starts = cued.starts;
                if (starts.length !== said.length) throw new Error(`${sc.name}/${format}: ${starts.length} cues for ${said.length} lines`);
                total = starts.at(-1) + said.at(-1).seconds + TAIL;
                const left = total * 1000 - (Date.now() - f.t0);
                if (left > 0) await new Promise((r) => setTimeout(r, left));
                if (f.me.errors.length) throw new Error(`${sc.name}/${format}: ${f.me.errors.join('; ')}`);
                cut = (f.t0 - f.videoStart) / 1000;
                await f.context.close();
            } finally { for (const fn of after.reverse()) await fn(); }
            const webm = join(vids, ls(vids).find((n) => n.endsWith('.webm')));
            const srt = said.map((l, i) => `${i + 1}\n${ts(starts[i])} --> ${ts(starts[i] + l.seconds + 0.15)}\n${l.text}\n`).join('\n');
            writeFileSync(join(work, 'subs.srt'), srt);
            writeFileSync(join(OUT, `${sc.name}-${format}.srt`), srt);
            /* 3. Assembled: the picture, each line at its time, the subtitles. */
            const ins = said.flatMap((l) => ['-i', l.file]);
            const mix = said.map((_, i) => `[${i + 1}]adelay=${Math.round(starts[i] * 1000)}|${Math.round(starts[i] * 1000)}[a${i}]`).join(';') + ';' + said.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${said.length}:normalize=0,apad[a]`;
            const out = join(OUT, `${sc.name}-${format}${process.env.THEME ? `-${process.env.THEME}` : ''}${burn ? '-burned' : ''}.mp4`);
            const { width: W, height: H } = FORMATS[format].out;
            const up = `scale=${W}:${H}:flags=lanczos,setsar=1`;
            const tail = ['-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
            if (burn) {
                const style = `FontName=DejaVu Sans,FontSize=${format === 'phone' ? 12 : 13},PrimaryColour=&H00FFFFFF,OutlineColour=&H20201C1A,BackColour=&H20201C1A,BorderStyle=3,Outline=5,Shadow=0,MarginV=${format === 'phone' ? 70 : 22}`;
                ffmpeg(['-ss', cut.toFixed(3), '-i', webm, ...ins, '-filter_complex', `${mix};[0:v]${up},subtitles=${join(work, 'subs.srt')}:force_style='${style}'[v]`, '-map', '[v]', '-map', '[a]', ...tail]);
            } else {
                ffmpeg(['-ss', cut.toFixed(3), '-i', webm, ...ins, '-i', join(work, 'subs.srt'), '-filter_complex', `${mix};[0:v]${up}[v]`, '-map', '[v]', '-map', '[a]', '-map', `${said.length + 1}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default', ...tail]);
            }
            ffmpeg(['-ss', String(Math.min(total - 0.5, starts[3] ?? starts.at(-1))), '-i', out, '-frames:v', '1', join(OUT, `${sc.name}-${format}-poster.png`)]);
            const problems = keyFrames(out, starts, said, total, join(OUT, `${sc.name}-${format}-keys.png`));
            if (problems.length) throw new Error(`${sc.name}-${format}: ${problems.join('; ')} (see ${sc.name}-${format}-keys.png)`);
            console.log(`${sc.name}-${format}: ${out} (${total.toFixed(1)} s), key frames: ${sc.name}-${format}-keys.png`);
        }
    } finally { rmSync(work, { recursive: true, force: true }); }
}

if (!(await ready())) { console.error('Pocket TTS is not serving: start it first (see tools/video/voice.mjs).'); process.exit(2); }
const all = readdirSync(join(HERE, 'scenarios')).filter((n) => n.endsWith('.mjs')).map((n) => n.slice(0, -4));
for (const n of asked) if (!all.includes(n)) { console.error(`no scenario ${n}: ${all.join(', ')}`); process.exit(2); }
const tools = await loadBench();
for (const name of asked.length ? asked : all) {
    const sc = (await import(pathToFileURL(join(HERE, 'scenarios', `${name}.mjs`)).href)).default;
    await make(sc, tools);
}
process.exit(0);
