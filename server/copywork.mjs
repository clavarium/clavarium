/* A COPY'S WORK FOLDER (conversations.copy, #221): made from its original's, here, as the files are -- its
 * chat with it (.parley's thread, its read marks, its attachments), the AI's files, all of /work -- but never
 * what belongs to the original alone:
 *   .docket   its reminders and what woke it: they would fire twice;
 *   .tether, .binder   its asks to the keepers and their answers, being answered: the copy asks its own;
 *   .parley's live files   its pulse, its voice boxes, its restart asked, its program (put again by the server).
 * Only plain files, folders and links: anything else (a socket, a pipe) is no work. Its copy keeps their times. */
import { cp, lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';

export const NOT_COPIED = Object.freeze(['.docket', '.tether', '.binder', '.parley/pulse.json', '.parley/speakers.json', '.parley/restart-asked', '.parley/server.mjs']);

/* Whether a path of the work folder (relative, '' for the folder itself) is copied. */
export function copied(path) {
    const p = path.split(sep).join('/');
    return !NOT_COPIED.some((x) => p === x || p.startsWith(`${x}/`));
}

/* `onProgress({ files, bytes })`: how far, as it goes (each file as it is taken) -- a long copy says so. */
export async function copyWorkFolder(from, to, onProgress) {
    const done = { files: 0, bytes: 0 };
    await cp(from, to, {
        recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: false,
        filter: async (source) => {
            if (!copied(relative(from, source))) return false;
            const s = await lstat(source).catch(() => null);
            const ok = Boolean(s && (s.isFile() || s.isDirectory() || s.isSymbolicLink()));
            if (ok && s.isFile()) { done.files += 1; done.bytes += s.size; onProgress?.({ ...done }); }
            return ok;
        },
    });
    return done;
}
