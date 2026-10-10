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

Not yet: folders, sign-on, shortcuts and voice, the installable app, delivery.

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

## Working here

Read `CONVENTIONS.md` first. Then:

    npm install          # also wires the hooks (npm run hooks does only that)

Put your leak guard next to the clone, as `../.clavarium-guard/guard.sh`. The
hooks find it there by themselves; `hooks/guard.sh` lists the other ways.
Without a guard, nothing commits. That is on purpose.

    npm run check    # what a push runs
