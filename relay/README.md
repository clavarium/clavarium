# clavarium-relay

The maintenance program of a Clavarium relay, a small root program in bash:

    clavarium-relay status | repair | update-os [--reboot] | update-relay X.Y.Z | rotate-key tunnel|keeper KEY

It is installed by `relay.sh` (or by `sudo clavarium online --relay HOST`) as
`/usr/local/sbin/clavarium-relay`. The home machine reaches it through the
account `clavarium-keeper`, which may run this program and nothing else.

`update-relay` is told a version number only: it fetches this package from the
npm registry itself and checks the registry's sha512 before installing it.

- Site: https://clavarium.org
- Source: https://github.com/clavarium/clavarium (folder relay/)

License: MIT.
