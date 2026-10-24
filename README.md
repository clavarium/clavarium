# Clavarium

A conversation is a VM with a terminal in it. Everything else is a folder.

- **Conversation**: one Multipass VM and one command running in tmux. The
  command is a setting: any command-line assistant, or a shell.
- **Screen**: the raw terminal of that command, in the browser. No chat layer.
- **Resource**: a folder mounted in the VM. A directory, a git repository, a
  mailbox and a secret all arrive as files.

## Where it stands

Built slice by slice; the plan is in `blueprint/architecture.html`, tab
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
  terminal; "auto" presses Enter once the person has stopped. Its engine is chosen
  in Settings, Dictation (a provider, its key one of the secrets);
  `CLAVARIUM_TRANSCRIPTION_URL` (and `_KEY`) in the environment is the fallback.

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
  at a time, on a cron line, or when an address of its own is called from
  outside (a scheduler, a workflow tool, a script). A line the owner wrote is typed to it. This is how two tools
  work together: one leaves a request in a folder they share, the other is
  woken. A cap of wake-ups an hour (0: none); a conversation asleep is not
  woken.

- **10 - alerts**: when a tool stops and waits for its owner, the owner's
  devices are told, through the browser's own push service: nothing of ours
  runs outside the house and no port is opened. Asked for on each device, in
  Settings; the message is encrypted for that device alone.

- **11 - the simple screen**: each conversation can be shown without its
  terminal, for whoever does not read one: its chat (12). While its chat is
  off, its Chat tab says so, with the one button that turns it on and asks
  its tool to use it. A device given its terminal but not its chat keeps
  the plain screen: a box to say what is wanted, what is ready to read, and
  what the tool says now as plain text, read by the page from its own
  screen; what is written is typed into the same terminal.

- **12 - talk through the app**: a branching on Clavarium Parley, a project
  of its own (an npm dependency at an exact version, `clavarium-parley`). Every machine has a
  read-only folder of tools at hand, `/tools`, with an index; Parley's
  archive is the first. Asked once, in its terminal, the tool installs it
  (`npm install -g /tools/...`) and talks through six commands: `parley
  tell`, `ask`, `show`, `read`, `status`, `doing`, in the person's language;
  it is also told to check out its branches in the repository's main folder
  or under /work, never in /tmp. Parley
  announces, this server decides: when the person wrote, one line is typed
  in its terminal ("You have a new message: run "parley read"."), once
  until it has read, never while somebody types there, never into a machine
  that does not run (the message waits). Opening the conversation shows
  its chat first, wherever it is opened (the list, a notification, a device
  given its chat, which may write there too), its terminal one click
  away where it was given; turned off, nothing changes. The chat, in two views: simple
  (bubbles, the one moving line of what it does now, gone with its next
  message, the steps before it folded into that message, times on hover or
  a long press, the day and long silences said); detailed (every step
  unfolded with its time and state, where it is, files with their paths,
  its terminal); in the
  device's language or one the owner chooses, with the owner's own words if
  he gives any; a file outside the shared folders is said so; the owner's
  phone is alerted when the tool asks or waits. Files travel in the chat both
  ways: what the tool shows, and what the person attaches to a message (put
  under /work/.parley/files/, the tool given its path). What is wrong with its
  machine, and its restarts, are grey lines in the thread, with what can be
  done; after a restart the tool is told once to read the whole thread again
  (`parley read --all`). The server keeps its own copy of the thread, out of
  the machine: a line the tool rewrites or deletes in /work/.parley, the
  owner's too, is shown as it was, and the thread says "History changed
  here". Off by default, per conversation; what the tool
  prints in its terminal is never read.

- **13 - the machine**: each conversation's machine is looked at after a
  start, a wake-up, a restart, and every two minutes while it runs (never one
  that sleeps): its state, whether it answers, its memory, its disk, and
  whether each folder that should be in it really is. A folder that came
  loose is unmounted and mounted again. What is wrong is said over its
  screen (the terminal or the chat), with "More memory..." where memory is
  short, "Restart..." (asked first; a clean stop, then by force) and "See the
  terminal"; no restart is offered while a machine merely starts. A terminal
  that does not come though its machine runs is repaired by the server
  itself (its channel opened again, its tmux made again if it does not
  answer), and only then is a restart offered. A tool that can take up its
  last session starts on it (`resume` in config/tools.json: `claude
  --continue`...), unless its owner chose "Start fresh".
  Its memory and disk are set in its settings (a disk only grows); the record
  holds what the VM manager says it has (drawn in `blueprint/machine.html`).
  The page's text has one size per
  device, the terminal's included; on a phone the terminal has the room.

- **14 - who gets what, and flows**: one screen draws every device,
  conversation and asset, and each right between them in the colour of what
  it gives (terminal, chat, read, write, use). At rest each box says how many
  links it has; a box touched shows its own, greys the rest and says them in
  words, through a conversation too. A link is made by dragging from a dot
  or touching one box then the other, changed or taken away by the knob on
  it: the same requests and confirmations as Access, Sharing and Assets. On
  a phone, a list, then one box and its links as rows. Apart, "Flows":
  the trace of one box (what reaches it, what it reaches, step by step),
  every group that touches nothing else, named after its most linked
  conversation, and a whole setup as one file (`server/setup.mjs`): its
  configuration, never its data, no secret, no key, no password, no time in
  it. A file is shown whole before it is imported (what is new, what is
  already here, what is missing, every text a tool will be typed); nothing
  in it runs on the server; a tool not in `config/tools.json` is refused.
  What a file cannot bring (a secret's value, a password, a device's
  pairing) waits, drawn dashed, and is done by itself once added. Drawn in
  `blueprint/flows.html`.

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
is a chosen list in one code; a secret is never shared with a device. A
conversation is shared in two parts, ticked one by one: its terminal ("use")
and its chat ("read" and "write"); its chat is proposed where it talks through
the app, its terminal otherwise, and either is changed later in its Sharing
chapter. The server refuses what was not given: no terminal, keys, shortcuts
or dictation into it without the terminal; none of the chat without the chat.
A device given the chat alone has the files of the chat, and nothing more: no
file browser, no import, only what the tool showed and what was attached to a
message.

A git repository can be added (Folders, "Add a git repository"): empty, or
cloned from an https address. It is then a folder like any other. Git is run
by the server once, at creation, and never in a repository a tool has written.
What the tool committed is shown to the owner before it is sent ("Review &
send"): the server fetches the commits into a copy of its own, shows them, and
pushes exactly what was shown with a key it keeps sealed (`server/gitpush.mjs`).
The tool never holds that key.

"To send", first in a conversation's Assets, shows every repository of that
conversation on one screen: each one its agent committed to is ticked, with
its branch and where it goes, and its checks run by themselves. One review
shows the changes of all those ticked; one button sends them one after the
other, each exactly as its own review would (the same commit, the same
target, the same guards). One refused, for example because its remote moved,
does not hold the others back, and each says what became of it.

A repository may also be cloned from a private remote (`server/gitaccess.mjs`),
over SSH (`user@host:path`, `ssh://...`) or HTTPS. The safest way in comes
first: an SSH key made by the server, whose private half is sealed in the vault
and never leaves the server -- only its public half is shown, to be added as a
deploy key; one key may open several repositories. An HTTPS access token, or a
user name and password (not recommended), are sealed too. Whatever opens the
remote is used by the server only, for the clone, for looking at what would
be sent, and for Send; a token only ever goes back to the origin it was given
for. For one git command at a time the SSH key is a 0600 file in a directory
of the server's own, removed right after; ssh trusts a host on first contact
and refuses it if its key changes later.

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

    # to try it on a machine of your own, with no domain: this machine only, no sign-in
    sudo deploy/install.sh --local

    # the stable version from npm, in local mode, asking nothing (Node.js pinned and
    # checked first); it prints the next command and the public keys (text and QR)
    curl -fsSL https://clavarium.org/install.sh | sudo bash
    # online in the same line: it installs, shows the setup key (text and QR), asks for the
    # relay's address once you made it with that key, waits for your DNS, sets the relay up
    # over SSH, tests from the internet, shows the password once
    DOMAIN=<your-domain>
    EMAIL=<your-email>
    curl -fsSL https://clavarium.org/install.sh | sudo bash -s -- --domain "$DOMAIN" --admin "$EMAIL" --relay-user ubuntu
    curl -fsSL https://clavarium.org/install.sh | sudo bash -s -- --direct --domain "$DOMAIN"
    # or later, from local mode
    sudo clavarium online --relay relay.example.net --domain clav.example.com
    sudo clavarium online --port --domain clav.example.com
    sudo clavarium key                  # the public keys again
    sudo clavarium relay status         # status | repair | update-os | update-relay | forget-setup-key

    # from npm, an exact version, checked (integrity, provenance, signatures);
    # it then updates itself (Settings, Updates; --updates auto|asap|ask|off,
    # --update-window 02:00-05:00, --channel latest|next) and keeps the last
    # two versions to go back to (deploy/updater.mjs)
    sudo npx clavarium@VERSION install --domain clav.example.com --operator you@example.com

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

The agreed design is in `blueprint/`: `architecture.html` (architecture,
security layers, resources, app and sharing, rules, decisions, plan) and
`app-designs.html` (three first design ideas for the installable app). Open
either file in a browser. The public site is `docs/`: plain files, no build.

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

## Licence

MIT. See `LICENSE`.
