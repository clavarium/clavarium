# Acceptance

The last gate before a stable release. The unit tests and the end-to-end bench
prove the code against stand-ins; this proves a REAL deployment: its real
address over HTTPS, its real sign-in, real machines, a real agent.

## When

- **Mandatory before any stable release** (`next` -> `latest`): on the test
  deployment, running the `next` version that is about to become stable.
- After a change of the sign-in, the updater, the machine sizes or the chat.
- Whenever a test deployment is rebuilt.

## What is needed

- A deployment on the `next` channel, reached at its real address.
- One conversation on it whose tool is signed in (an agent that answers) and
  that the operator lets this run use: it is sent one harmless, labelled
  message, put in a folder and back, restarted, and given one step more memory
  and then its memory back. Nothing of its work is created, changed or deleted.
- The account it signs in as, in the environment (never in a file here):
  `CLAVARIUM_ACCEPT_EMAIL`, `CLAVARIUM_ACCEPT_PASSWORD`.
- A browser: the `playwright` package, or `CLAVARIUM_E2E_PLAYWRIGHT` pointing at one.
- Some disk on the computer it runs from: the report and its pictures take a few megabytes.

## How

```
CLAVARIUM_ACCEPT_EMAIL=... CLAVARIUM_ACCEPT_PASSWORD=... \
  npm run acceptance -- --target https://clav.example.com --conversation NAME [--report DIR] [--dry]
```

- `--dry`: everything but the restart and the resize (a few minutes; no machine is stopped).
- `--report DIR`: where the HTML report (`index.html`), `report.json` and the
  pictures go; by default a new folder under the system's temporary folder.
  Never inside this repository.
- `--chat-minutes N`: how long the agent has to answer (5 by default).

It exits 0 when every check passed. A full run takes about a quarter of an
hour; most of it is the machine restarting three times.

Then the two checks it cannot make:

- [`phone.md`](phone.md): ten minutes on a real Android phone and a real iPhone.
- [`claude-for-chrome.md`](claude-for-chrome.md): optional, a second pair of
  eyes on clarity, given as it is to a browser agent on a real desktop Chrome.

## The checks

| # | Check | Pictures |
|---|-------|----------|
| 1 | Sign-in through the real sign-in page | |
| 2 | The list loads, with the name of the instance | tablet, phone |
| 3 | Search (`/`) finds the conversation; Escape empties, then closes | tablet |
| 4 | The conversation goes into a folder "Acceptance" | tablet |
| 5 | Navigation contract on a phone: Back and Escape on the search, Assets, Access, Settings, the conversation and each of its tabs | phone |
| 6 | Chat: the labelled message, "Received, thinking...", then its agent's status and answer | tablet, phone |
| 7 | Assets: the Git repository, its branch diagram, its review, Back | tablet, phone |
| 8 | The "Last checks" card (run once if none was kept yet; nothing is sent) | tablet |
| 9 | Settings tab, Machine: its sizes | tablet |
| 10 | Restart: the tool comes back on its last session, never "No conversation found" | tablet |
| 11 | Resize: one step more memory; it comes back with it | tablet |
| 12 | Access map: three "+" and "All devices" | tablet, phone |
| 13 | Settings: the name of the instance, changed and put back | tablet |
| 14 | Settings, Updates: the version and the channel | tablet |
| 15 | Restore: its folder, its memory, the name of the instance, as they were | tablet |

## Ready means

A stable release is **ready** when, on the version about to be released:

1. a full run (not `--dry`) passed every check;
2. the update path was tried on the same deployment: the updater's history
   shows the update applied, a rollback to the kept release and forward again
   both came back (`clavarium-host update rollback <release>`, then
   `update apply <version>`);
3. `phone.md` was gone through on a real phone, every line ticked;
4. nothing it found is left open except what is written down as known, with a reason.

What was not tried is written as not tried.
