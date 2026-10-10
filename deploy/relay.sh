#!/bin/bash
# ---------------------------------------------------------------------------
# TURNS THIS MACHINE INTO THE RELAY OF ONE CLAVARIUM. One command, parameters
# only. Run it on a small machine that has a public address; the machine at
# home dials out to it, so home needs no open port and no fixed address.
#
#   sudo deploy/relay.sh --key "ssh-ed25519 AAAA... clavarium-tunnel"
#
#   --key LINE     the PUBLIC key of the home machine (install.sh prints it)
#   --dry-run      check the parameters, say what would be done, do nothing
#
# THE RELAY IS BLIND. It carries bytes: TLS starts in the browser and ends at
# home, so this machine never sees a page, a keystroke or a password. It holds
# no certificate and no secret of yours.
#
# WHAT IT SETS UP:
#   - an account, "clavarium-tunnel", that can do ONE thing: hold two
#     listening ports (8443, 8080) forwarded to home. No shell, no terminal,
#     no command, no other forwarding;
#   - a rule that sends what arrives on 443 and 80 to those two ports.
#
# WHAT A BLIND RELAY CAN STILL DO, and how to close it: whoever controls this
# machine receives port 80 for your name, so it could answer a certificate
# authority's challenge itself and obtain a valid certificate for your name.
# One DNS record closes that: a CAA record that names YOUR certificate
# account ("accounturi="). The end of this script says it again.
#
# Exit codes: 0 done; 64 bad parameters; 78 this machine is refused.
# ---------------------------------------------------------------------------
set -euo pipefail

ACCOUNT="clavarium-tunnel"
TLS_PORT="8443"
HTTP_PORT="8080"
SSHD_FILE="/etc/ssh/sshd_config.d/10-clavarium-relay.conf"
KEYS_DIR="/etc/ssh/clavarium-relay"
RULES="/etc/clavarium-relay.nft"
UNIT="/etc/systemd/system/clavarium-relay-ports.service"

bad() { echo "relay: $*" >&2; echo "usage: relay.sh --key \"ssh-ed25519 AAAA... name\" [--dry-run]" >&2; exit 64; }
refuse() { echo "relay: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

KEY=""; DRY="no"
while [ $# -gt 0 ]; do
    case "$1" in
        --key) KEY="${2:-}"; shift 2 || bad "--key needs a value" ;;
        --dry-run) DRY="yes"; shift ;;
        *) bad "unknown parameter: $1" ;;
    esac
done
# The key goes into a file that gives rights: it must be exactly a public
# key, on one line, with nothing that could add an option next to it.
case "$KEY" in *"PRIVATE KEY"*) bad "this is a PRIVATE key: it must never leave home. Give the public one (one line, starts with ssh-ed25519)" ;; esac
[[ "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]{68}(\ [A-Za-z0-9@._-]{1,64})?$ ]] || bad "--key is one line: ssh-ed25519, the key, and optionally a name"

if [ "$DRY" = "yes" ]; then
    cat <<PLAN
would make this machine a relay:
  account     $ACCOUNT: may hold ports $TLS_PORT and $HTTP_PORT forwarded to home, and nothing else
  ports       443 -> $TLS_PORT, 80 -> $HTTP_PORT
  sees        nothing: TLS ends at home
PLAN
    exit 0
fi

[ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in *ubuntu*|*debian*) : ;; *) refuse "this is ${PRETTY_NAME:-an unknown system}; the relay installs on Ubuntu or Debian" ;; esac
command -v sshd >/dev/null 2>&1 || refuse "there is no SSH server on this machine (package openssh-server)"
grep -Eqs '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config || refuse "/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d: the account could not be bounded"
check="$(mktemp)"; printf '%s\n' "$KEY" > "$check"
ssh-keygen -l -f "$check" >/dev/null 2>&1 || { rm -f -- "$check"; refuse "this is not a key the SSH tools recognise"; }
rm -f -- "$check"
for port in 443 80 "$TLS_PORT" "$HTTP_PORT"; do
    # (On a second run, the tunnel itself holds two of them: that is the SSH server.)
    if ss -ltnpH "sport = :$port" 2>/dev/null | grep -v '"sshd"' | grep -q .; then refuse "something already listens on port $port here: a relay needs 443 and 80 for itself"; fi
done

step "packages"
command -v nft >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq nftables >/dev/null; }

step "account"
id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
install -d -o root -g root -m 0755 "$KEYS_DIR"
# The key file belongs to root: the account cannot give itself another key.
printf 'restrict,port-forwarding,permitlisten="%s",permitlisten="%s" %s\n' "$TLS_PORT" "$HTTP_PORT" "$KEY" > "$KEYS_DIR/$ACCOUNT"
chmod 0644 "$KEYS_DIR/$ACCOUNT"
cat > "$SSHD_FILE" <<SSHD
# Clavarium relay: what the tunnel account may do. Written by relay.sh.
Match User $ACCOUNT
    AuthorizedKeysFile $KEYS_DIR/%u
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    GatewayPorts clientspecified
    PermitListen $TLS_PORT $HTTP_PORT
    PermitOpen none
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    ForceCommand /bin/false
SSHD
if ! sshd -t; then rm -f -- "$SSHD_FILE"; refuse "the SSH server refused these settings; they were taken out again"; fi
systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service

step "ports"
cat > "$RULES" <<NFT
# Clavarium relay: what arrives on 443 and 80 goes to the tunnel. Written by relay.sh.
table inet clavarium_relay
delete table inet clavarium_relay
table inet clavarium_relay {
  chain arriving {
    type nat hook prerouting priority dstnat;
    tcp dport 443 redirect to :$TLS_PORT
    tcp dport 80 redirect to :$HTTP_PORT
  }
}
NFT
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Clavarium relay - 443 and 80 go to the tunnel
After=network-pre.target
Before=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $RULES
ExecStop=/usr/sbin/nft delete table inet clavarium_relay

[Install]
WantedBy=multi-user.target
UNITFILE
systemctl daemon-reload
systemctl enable --quiet clavarium-relay-ports.service
systemctl restart clavarium-relay-ports.service
systemctl is-active --quiet clavarium-relay-ports.service || refuse "the port rule could not be loaded: journalctl -u clavarium-relay-ports"

echo
echo "This machine is a relay. It waits for the home machine to dial in."
echo "Compare with what the home machine printed (it must be the same):"
echo "    $(ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f2)"
echo "Point your name at this machine's public address (ports 443 and 80 must reach it)."
echo
echo "TO KEEP THIS RELAY BLIND, add a CAA record to your DNS that names your certificate"
echo "account (accounturi=...). Without it, whoever controls this machine could obtain a"
echo "certificate for your name. The account address is at home, after the first certificate:"
echo "    sudo grep -rho '\"location\": *\"[^\"]*\"' /var/lib/caddy/caddy/acme"
