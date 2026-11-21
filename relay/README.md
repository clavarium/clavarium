# clavarium-relay

The maintenance program of a Clavarium relay, a small root program in bash:

    clavarium-relay status | repair | update-os [--reboot] | update-relay X.Y.Z | rotate-key tunnel|keeper KEY
    clavarium-relay homes | add-home NAME --key KEY | remove-home NAME | name-principal NAME

It is installed by `relay.sh` (or by `sudo clavarium online --relay HOST`) as
`/usr/local/sbin/clavarium-relay`. The home machine that set the relay up, the
principal, reaches it through the account `clavarium-keeper`, which may run
this program and nothing else.

`update-relay` is told a version number only: it fetches this package from the
npm registry itself and checks the registry's sha512 before installing it.

## Several homes on one relay

A relay can carry several Clavarium homes, each on its own domain name. It
stays blind: it never decrypts anything and holds no certificate.

- On port 443 a small router reads the name the visitor asks for (SNI, sent in
  the clear at the start of TLS) and passes the bytes, untouched, to that
  home's tunnel. On port 80 it reads the Host line. An unknown name is closed
  (443) or answered 421 (80); it never goes to a default home.
- Each home has its own tunnel key, allowed to hold its own two ports and no
  other. The list is `/etc/clavarium-relay/homes`.
- Homes are added and removed from the principal only:
  `sudo clavarium relay invite NAME` gives a one-time code, which the new
  home types: `sudo clavarium online --relay PRINCIPAL --domain NAME --join CODE`.
- A relay set up with an older version keeps working as it was. Its next
  `update-relay` moves its one home to the list, as the principal; routing by
  name starts once the principal has told the relay its name.

For each name, add a CAA record that names that home's certificate account:
otherwise whoever controls the relay could obtain a certificate for the name.

- Site: https://clavarium.org
- Source: https://github.com/clavarium/clavarium (folder relay/)

License: MIT.
