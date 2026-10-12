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

- **8 - the answerer**: while the owner is away, several models read a
  question the tool asks and answer in the owner's place, only when they all
  give the same answer; one doubt and the owner is asked. Off by default,
  per conversation, and never on without objectives and a charter. A limit of
  answers in a row (0: none), and a log of everything. It is the one place
  where the server reads what a tool prints, and the screen of that
  conversation is sent to the models. Needs `CLAVARIUM_ANSWERER_URL` (a
  "chat completions" address), `CLAVARIUM_ANSWERER_MODELS` (names, separated
  by commas; three of different makers is the idea) and `_KEY` in the
  environment.

- **9 - wake-ups**: a tool is told to get to work without its owner: when
  something arrives in a folder, a repository or a mailbox attached to its
  conversation (a file, a mail, a commit), every so many minutes, every day
  at a time, or on a cron line. A line the owner wrote is typed to it. This is how two tools
  work together: one leaves a request in a folder they share, the other is
  woken. A cap of wake-ups an hour (0: none); a conversation asleep is not
  woken.

Not yet: mailbox and git resources, delivery.

Where the tool works (`/work`) is a folder kept by the server: what the tool
makes is seen in Files and outlives its machine. It is a disk of a fixed size
(10 GB; `WORK_MB=` in `/etc/clavarium/host.conf` changes it), so a tool that
runs away fills its own disk and not the host's. A conversation can be created
to work on its machine's own disk instead, and moved from one to the other
later (its tool is stopped for the move; a gigabyte must stay free). A kept
folder refuses symbolic links that point upwards or outside -- what installed
packages are full of -- so a code project belongs on the machine's disk.
Attached folders have no such limit yet.

Who may do what with what is one table (`server/grants.mjs`): a subject (a
conversation, or a device's pairing), an asset (conversation, folder, mailbox,
git repository, secret) and rights -- read, write, use. Attaching a folder to
a conversation and sharing with a device are lines of the same table. A share
is a chosen list in one code; a secret is never shared with a device.

A git repository can be added (Folders, "Add a git repository"): empty, or
cloned from an https address. It is then a folder like any other. Git is run
by the server once, at creation, and never in a repository a tool has written.
What the tool committed is shown to the owner before it is sent ("Review &
send"): the server fetches the commits into a copy of its own, shows them, and
pushes exactly what was shown with a key it keeps sealed (`server/gitpush.mjs`).
The tool never holds that key.

A mailbox can be added as a folder (Folders, "Add a mailbox as a folder"): its
recent messages become files that a conversation reads and never writes; the
mailbox itself is never changed. For a mail server of your own whose
certificate authority is private, `CLAVARIUM_MAIL_CA` names its file.

The host also needs `nft` (the network rules).

The host needs `tmux` and `bindfs` (the read-only views).

    npm install

    # the product: conversations are Multipass VMs. The server has no rights
    # of its own: it reaches root only through deploy/clavarium-host, which
    # reads its data directory from /etc/clavarium/host.conf (DATA=/path/to/data)
    node server/main.mjs --host "sudo -n /usr/local/sbin/clavarium-host" --data /path/to/data
    # then open http://127.0.0.1:7717/

    # or, on a fresh Ubuntu Server (24.04, 26.04), everything above in one command:
    # an account with no rights, the one program it may run as root, a service.
    # and, in front, TLS and a sign-in that knows the operators (pinned releases).
    # It prints each operator's password once. --core-only leaves the front out.
    sudo deploy/install.sh --domain clav.example.com --operator you@example.com

    # or all of it as one VM on any computer that has Multipass (the computer is left alone)
    deploy/appliance.sh --domain clav.example.com --operator you@example.com --relay relay.example.net

    # a relay for a machine at home (run on the relay; install.sh --relay prints the line)
    sudo deploy/relay.sh --key "ssh-ed25519 AAAA... clavarium-tunnel"

    # a backup is two files -- the archive, and the key of the vault apart
    sudo deploy/backup.sh --to /path/to/a/folder
    sudo deploy/restore.sh clavarium-DATE.tgz --vault-key clavarium-DATE.vault-key

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
tmux sessions; only the privileged host program is a stand-in
(`e2e/fake-clavarium-host.mjs`, which plays each VM as a directory). It needs a browser:
the `playwright` package, or `CLAVARIUM_E2E_PLAYWRIGHT` pointing at one.
Without a browser its tests are skipped, and say so.

## Working here

Read `CONVENTIONS.md` first. Then:

    npm install          # also wires the hooks (npm run hooks does only that)

Put your leak guard next to the clone, as `../.clavarium-guard/guard.sh`. The
hooks find it there by themselves; `hooks/guard.sh` lists the other ways.
Without a guard, nothing commits. That is on purpose.

    npm run check    # what a push runs
