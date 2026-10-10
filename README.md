# Clavarium

A conversation is a VM with a terminal in it. Everything else is a folder.

- **Conversation**: one Multipass VM and one command running in tmux. The
  command is a setting: any command-line assistant, or a shell.
- **Screen**: the raw terminal of that command, in the browser. No chat layer.
- **Resource**: a folder mounted in the VM. A directory, a git repository, a
  mailbox and a secret all arrive as files.

Nothing is built yet. The agreed design is in `docs/blueprint/`:

- `architecture.html`: architecture, security layers, resources, app and
  sharing, rules, what is decided, and the plan in nine slices;
- `app-designs.html`: three first design ideas for the installable app.

Open either file in a browser.

## Working here

Read `CONVENTIONS.md` first. Then, once per clone:

    git config core.hooksPath hooks
    git config clavarium.guard <path to your leak guard>

Without a declared guard, nothing commits. That is on purpose.

    npm run check    # what a push runs
