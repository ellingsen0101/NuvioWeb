#!/usr/bin/env bash
# Sets up the Nuvio Web backend on an Oracle Cloud "Always Free" Ubuntu server, or any Ubuntu server.
# Run it on the server, as the default user:
#   curl -fsSL https://raw.githubusercontent.com/ellingsen0101/NuvioWeb/develop/deploy/oracle/setup.sh | bash
# Safe to run again: it updates the code and keeps existing secrets and invite codes.
set -euo pipefail

REPO="${REPO:-https://github.com/ellingsen0101/NuvioWeb.git}"
BRANCH="${BRANCH:-develop}"
FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-https://ellingsen0101.github.io}"
DIR="${DIR:-/opt/nuvio-web}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Installing Docker and git"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git openssl iptables-persistent >/dev/null 2>&1 || \
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git openssl iptables-persistent >/dev/null
if ! command -v docker >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null
fi
if ! docker compose version >/dev/null 2>&1 && ! sudo docker compose version >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 || \
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null
fi
sudo systemctl enable --now docker >/dev/null

say "Opening ports 80 and 443 in the server's own firewall"
# Oracle's Ubuntu images reject everything except SSH. The rules go before that reject rule.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
sudo netfilter-persistent save >/dev/null 2>&1 || true

say "Getting the code"
if [ -d "$DIR/.git" ]; then
  sudo git -C "$DIR" fetch --quiet origin "$BRANCH"
  sudo git -C "$DIR" checkout --quiet "$BRANCH"
  sudo git -C "$DIR" reset --quiet --hard "origin/$BRANCH"
else
  sudo git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/server"

IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"

if [ ! -f .env ]; then
  say "Creating secrets"
  OWNER_KEY="$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32)"
  sudo tee .env >/dev/null <<EOF
ACCESS_KEYS=$OWNER_KEY
TOKEN_SECRET=$(openssl rand -base64 48 | tr -d '/+=\n')
ALLOWED_ORIGINS=$FRONTEND_ORIGIN
BACKEND_DOMAIN=$DOMAIN
ENABLE_TORRENTS=false
ALLOW_TRANSCODE=false
MAX_SESSIONS=6
MAX_FFMPEG_PROCESSES=3
MAX_CACHE_GB=20
EOF
  sudo chmod 600 .env
  NEW_OWNER_KEY=1
fi

say "Building and starting (the first build takes a few minutes)"
sudo docker compose up -d --build

say "Waiting for HTTPS"
BACKEND="https://$(sudo grep '^BACKEND_DOMAIN=' .env | cut -d= -f2)"
for _ in $(seq 1 60); do
  if curl -fsS "$BACKEND/healthz" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done

if [ "${OK:-}" != 1 ]; then
  say "The backend runs, but $BACKEND can't be reached from outside yet."
  echo "Most likely the cloud firewall is still closed. In the Oracle console, open your instance's"
  echo "subnet > Security List > Add Ingress Rules: source 0.0.0.0/0, TCP, destination ports 80 and 443."
  echo "Then run this script again."
  exit 1
fi

say "Done. Your backend is at $BACKEND"
if [ "${NEW_OWNER_KEY:-}" = 1 ]; then
  echo "Owner access key (shown once, also in $DIR/server/.env): $(sudo grep '^ACCESS_KEYS=' .env | cut -d= -f2)"
fi
cat <<EOF

Make an invite code for a friend:
  cd $DIR/server && sudo docker compose exec backend node scripts/invites.mjs add "Name"
Revoke it:
  cd $DIR/server && sudo docker compose exec backend node scripts/invites.mjs remove "Name"
Update to the latest version later by running this script again.
EOF
