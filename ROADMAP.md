# Roadmap

What is decided but not built yet, in the order it is meant to be done.
What is built is described in README.md; what is being built now is not
listed here.

## Next

- **Network limits per agent.** A machine reaches only its model provider and
  the addresses its owner allows; everything else is refused from outside the
  machine, and "Who gets what" shows it. Today an agent can send what
  it reads to any address on the internet, without any of the owner's keys
  (for example by pushing its repository to a server of its own).
- **Checks run in the runner.** The pre-push hook and the owner's check command
  run in the same blind, throw-away sandbox that reads the agent's commits,
  from the fetched commits only, so their result no longer depends on the
  agent's machine.
- **"Ask to send".** The agent can ask for a branch to be sent; the server
  applies the same rules as an automatic send, or asks the owner on the phone.
- **GitLab webhook.** GitLab calls the server on each push, so the reference
  repository is refreshed at once instead of every few minutes.

- **Parley on npm.** An agent installs Parley itself (`npm install -g
  clavarium-parley`, an exact version) when it is asked to talk through the
  app; until then it installs it from the archive in `/tools`, read-only in
  every machine.

- **Lines for a whole installation in the guide.** The owner's lines are set
  per conversation; house rules shared by every conversation (and carried once
  in an exported setup) would save copying them.
- **"Tell it again" only when the tool is idle.** The line is typed when the
  owner clicks, even if the tool is in the middle of something.

- **A tool's session outlives its machine.** A tool already starts on its last
  session; that session is kept in the work folder too, so that it survives a
  machine built again, a backup and a restore.
- **Every word of the app in the owner's language.** English by default,
  French at least, a file per language, the owner's own words over any of them
  (as the chat already does).
- **Two servers, two apps that tell themselves apart.** The app installed from
  a server carries that server's name (and a mark of its own on the icon).

## Later

- **Lock files in .git with a sticky bit**, as a second belt behind the runner,
  if a test shows it holds through the multipass mount.
- **An events folder per agent.** Each agent writes one file per event; each
  box shows the count of the last 24 hours and a mark when something waits;
  old files are purged after a delay the owner chooses.
- **The machine starting, as on a console.** While a machine is built, its
  start log is shown under the three steps.

## Published on npm, with automatic updates

- **Clavarium is published on npm**, from GitHub only, with npm provenance, so
  every version can be traced to this repository. Installing on Ubuntu means
  installing the package, then running its install script, which sets up the
  service and the host program. npm itself never runs anything as root.
- **Automatic updates: the administrator decides, and the decision is kept.**
  - Off by default. The install asks; nothing is updated unless the
    administrator says so, and nothing overrides that choice later.
  - Turned on, the administrator chooses how deep updates go: patches only
    (1.4.2 to 1.4.3), minor versions too (1.4 to 1.5), or major versions too
    (1 to 2).
  - The administrator chooses update windows: every night, a day of the week,
    a day of the month, and an hour range. Turned on with no window given, it
    is every night between 2 and 5 am. Inside a window the server picks a
    random moment to look for a new version, so a fleet of servers does not
    all update at the same minute.
  - The new version is downloaded beside the current one, checked, switched
    to, started; if it does not start, the previous one comes back.
  - Never while a machine is being built or a git send is in progress.
  - Whatever is not installed by itself is announced in the page, plainly:
    "A new version exists (1.5.0). [Update now] [Set up automatic updates]".
- **The safety of automatic updates.** An update installs code that runs with
  the host program's rights on every server, so:
  1. the provenance is checked before installing: the version must have been
     built and published from this repository on GitHub;
  2. a version is installed only once it has been public for a delay (one or
     two days by default), so a bad release is caught before it spreads;
  3. only the depth the administrator chose (patch, minor or major) is ever
     installed by itself;
  4. a version that changes the host program is announced to the
     administrator, and can be set to wait for a manual confirmation.

## Site

- **A virtual machine image to download**, with Clavarium already inside, to
  open in Hyper-V, VMware or VirtualBox. Look first at how such images are
  built and published from GitHub (release assets, size limits). It needs
  nested virtualisation on the visitor's computer: try it for real first.
- **A Windows installer that makes and starts that machine.** Lower priority:
  it needs experiments on real Windows computers before anything is promised.
