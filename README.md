# Clavarium

A conversation is a VM with a terminal in it. Everything else is a folder.

- **Conversation**: one Multipass VM and one command running in tmux. The
  command is a setting: any command-line assistant, or a shell.
- **Screen**: the raw terminal of that command, in the browser. No chat layer.
- **Resource**: a folder mounted in the VM. A directory, a git repository, a
  mailbox and a secret all arrive as files.

## Where it stands

Built slice by slice; the plan is in `docs/blueprint/architecture.html`, tab
"Plan". Done so far:

- **0 - repository and rules**: hooks, checks, conventions.
- **1 - the terminal**: a browser page drives a command-line tool running alone
  in tmux; a reload finds the same session; the newest screen takes over.
- **2 - a conversation is a VM**: created from the page with a tool chosen in
  `config/tools.json`; it keeps running when the page is closed, stops a
  minute after the tool has exited, sleeps and wakes on request, is archived.

- **3 - folders**: a folder kept by the server is attached to a conversation
  read-only or read-write and appears under `/resources/` in its VM; the same
  folder can be shared by several conversations; read-only is enforced on the
  host; a Files panel lists, downloads and imports.

- **4 - the edge**: with `--operators`, an authenticating proxy must stand in
  front; pages, API and terminal refuse anyone who is not a declared operator.

- **5 - hands**: one-click shortcuts (sent, or left to complete), and
  dictation: the microphone stays open and each phrase is typed into the
  terminal; "auto" presses Enter once the person has stopped. Dictation needs
  `CLAVARIUM_TRANSCRIPTION_URL` (and `_KEY`) in the environment.

- **6 - the app and sharing**: the page is installable; a conversation is
  shared with a one-use QR code; the device that scans it makes its own key,
  sees that one conversation under `/c/` and nothing else, and can be revoked.

- **7 - secrets, network, sign-in**: a secret is sealed at rest and handed to
  a tool as a file in memory and a variable; a conversation can be switched
  offline, and conversations never reach each other, both enforced on the
  host; a mailbox dedicated to a tool's account is watched, read-only, and
  its sign-in link shown to the operator next to the terminal.

Not yet: mailbox and git resources, delivery.

The host also needs `nft` (the network rules).

The host needs `tmux` and `bindfs` (the read-only views).

    npm install

    # the product: conversations are Multipass VMs
    node server/main.mjs --multipass "sudo multipass" --data /path/to/data
    # then open http://127.0.0.1:7717/

    # development, no VM: one tool on this machine
    node server/main.mjs --command "your-tool" --cwd /path/to/work
    # then open http://127.0.0.1:7717/?c=demo

It listens on the loopback interface only.

The agreed design is in `docs/blueprint/`: `architecture.html` (architecture,
security layers, resources, app and sharing, rules, decisions, plan) and
`app-designs.html` (three first design ideas for the installable app). Open
either file in a browser.

## Tests

    npm test             # unit and integration tests: no VM, no browser
    npm run test:e2e     # end to end: the real server, a real browser, real terminals
    npm run check        # everything a push runs

The end-to-end suite drives the real pages against the real server and real
tmux sessions; only the VM manager and the privileged host commands are
stand-ins (`e2e/fake-multipass.mjs`, `e2e/fake-host.mjs`). It needs a browser:
the `playwright` package, or `CLAVARIUM_E2E_PLAYWRIGHT` pointing at one.
Without a browser its tests are skipped, and say so.

## Working here

Read `CONVENTIONS.md` first. Then:

    npm install          # also wires the hooks (npm run hooks does only that)

Put your leak guard next to the clone, as `../.clavarium-guard/guard.sh`. The
hooks find it there by themselves; `hooks/guard.sh` lists the other ways.
Without a guard, nothing commits. That is on purpose.

    npm run check    # what a push runs
