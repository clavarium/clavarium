# Conventions

For whoever writes in this repository. Nothing here is needed to use Clavarium.

## 1. Everything is in English

Source code, comments (plain ASCII, explaining why and not what), documents,
commit messages, default interface strings. Another language is a label file,
never a patch.

## 2. Nothing identifies anyone

No person, company, client, supplier, production site or machine: not in the
code, the examples, the documents, the hooks, the commit messages, the branch
names or the git author field. Nor anything that identifies without naming: an
absolute path from a machine, a real email address, a fixed IP address.

Use `example.com`, `/path/to/thing`, `you@example.com`. Commits are signed with
a GitHub noreply address.

Two guards enforce it, and neither replaces the other:

- **names** have no shape. The list lives outside the repository, because a
  list of words that must not be published cannot be published. The hooks
  look for it next to the repository, at `../.clavarium-guard/guard.sh`: a
  relative path, so that no restart and no new clone can lose it. No guard
  found, no commit. `npm run check` fails if the hooks are not wired or the
  guard does not answer.
- **shapes** need no secret list: a home directory, an email address, a machine
  address. `tools/check-shapes.mjs` refuses them, here and anywhere.

## 3. No assistant signs anything

No co-author trailer, no session link, no assistant in the author field or in a
commit message. `tools/check-ai-names.mjs` says exactly what is refused where.
Files may name the command-line assistants this product runs: that is its
subject. They may not be signed by one.

## 4. A commit is cheap, a push is gated

- `pre-commit`: only what can never be taken back (names, signatures).
- `commit-msg`: the message.
- `pre-push`: everything, `npm run check` included.

Fix the cause, never the check.

## 5. Agree, then code

No feature without a diagram or a mockup accepted first. `blueprint/` is
the reference; a change of mind changes it first. `docs/` is the public site,
served as it is: no build, and `test/site.test.mjs` checks its links.

## 6. Stay small

The server never parses what a tool prints. Adding a tool is a line of
configuration, not code.

## 7. Prove it for real

A slice ends with one run against a real machine and a real tool, and a
screenshot. What was not tried is written as not tried.

## 8. One look for every setting

Every screen where something is set (Settings, a conversation's settings,
an asset, Access and a device, To send and the review) is made of the same
few pieces, styled once in `web/style.css` (the block "SETTINGS, AND A
CONVERSATION'S SETTINGS: one look", and the one after it for the other sheets):

- **chapter**: a `details.chapter` card; its title and a summary of 2 to 5
  words; a chevron, never a word, says it is open.
- **set-row**: one setting. On the left its name (1 to 3 words) and at most
  one short line (`small`, 5 to 10 words) saying what it is; on the right its
  control. One under the other on a phone. Several in a form: `.set-rows`.
- **status-line**: a state, with a dot (`data-tone`: ok, warn, bad):
  "On · whisper-large · chosen here".
- **callout**: what asks for an action (a key missing, a rebuild refused).
- **list-item**: one thing of a list (a shortcut, an administrator, a key):
  its name and a line on the left, its actions on the right.
- **action-row**: the buttons of a form, at its end, the main one last; a
  status message on its left.
- **more**: a `details.more` with a small "i": what is long and rarely needed.
- **confirm**: a `callout confirm` before what cannot be taken back: its line,
  then its buttons, the main one last.
- Rows in a card: one line between two rows in sight, whatever is hidden.
- Fields and selects are styled by the place they are in, never one by one.

The words follow the same rule: a setting is described, never narrated --
not what it will do, nor what was done. State as "Name: value". Keep only
the safety facts (never shown, cannot be undone), in a few words. If the
title or its summary says it, the body does not say it again.
