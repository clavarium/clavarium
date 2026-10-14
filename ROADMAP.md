# Roadmap

What is decided but not built yet, in the order it is meant to be done.
What is built is described in README.md; what is being built now is not
listed here.

## Next

- **Network limits per agent.** A machine reaches only its model provider and
  the addresses its owner allows; everything else is refused from outside the
  machine, and the "who sees what" map shows it. Today an agent can send what
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
- **Automatic updates, off unless the administrator turns them on.**
  - The administrator chooses update windows: every night, a day of the week,
    a day of the month, and an hour range. Inside a window the server picks a
    random moment to look for a new version, so a fleet of servers does not
    all update at the same minute.
  - The new version is downloaded beside the current one, checked, switched
    to, started; if it does not start, the previous one comes back.
  - Never while a machine is being built or a git send is in progress.
  - Turned off (the default), nothing is ever installed by itself: the page
    only says that a new version exists, and the administrator updates by
    hand when they decide to.
- **The safety of automatic updates.** An update installs code that runs with
  the host program's rights on every server, so:
  1. the provenance is checked before installing: the version must have been
     built and published from this repository on GitHub;
  2. a version is installed only once it has been public for a delay (one or
     two days by default), so a bad release is caught before it spreads;
  3. never a new major version without the administrator's consent;
  4. a version that changes the host program is announced to the
     administrator, and can be set to wait for a manual confirmation.

## Site

- **The new site goes into the repository** (docs/, served as it is by GitHub
  Pages), with checks that every page has the same header and
  footer and that no link is broken.
- **Install, Linux first:** the install command for Ubuntu as the main button,
  one line on choosing an AI provider, and a plain "how to start" for people
  who do not code. Docker is not offered: Clavarium makes virtual machines,
  which a container cannot.
- **A virtual machine image to download**, with Clavarium already inside, to
  open in Hyper-V, VMware or VirtualBox. Look first at how such images are
  built and published from GitHub (release assets, size limits). It needs
  nested virtualisation on the visitor's computer: try it for real first.
- **A Windows installer that makes and starts that machine.** Lower priority:
  it needs experiments on real Windows computers before anything is promised.
