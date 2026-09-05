#!/usr/bin/env bash
# Varco — self-configuring setup script.
# Bootstraps Cloudflare resources (KV namespace, secrets, deploy) and
# collects Backblaze B2 connection details. Safe to re-run (idempotent):
# it skips steps that are already done (existing KV id, existing login).
#
# What this script does NOT do (must be done by hand first / separately):
#   - create the B2 bucket or its Application Key (README, step 1-2)
#   - configure Cloudflare Access on /admin, /api/invite, /api/upload (README, step 6)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mATTENZIONE:\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }

if ! command -v npm >/dev/null 2>&1; then
  echo "npm non trovato. Installa Node.js (https://nodejs.org) e rilancia questo script." >&2
  exit 1
fi

info "Installazione dipendenze npm (include la CLI wrangler)..."
npm install
ok "Dipendenze installate."

WRANGLER="npx wrangler"

info "Verifica login Cloudflare..."
if $WRANGLER whoami >/dev/null 2>&1; then
  ok "Già autenticato su Cloudflare."
else
  info "Apro il login Cloudflare nel browser..."
  $WRANGLER login
  ok "Login completato."
fi

if grep -q 'REPLACE_WITH_KV_NAMESPACE_ID' wrangler.toml; then
  info "Creazione KV namespace FILES_KV..."
  KV_OUTPUT=$($WRANGLER kv namespace create FILES_KV)
  echo "$KV_OUTPUT"
  KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -n1 || true)
  if [ -z "$KV_ID" ]; then
    warn "Impossibile estrarre automaticamente l'id del namespace. Copialo manualmente dall'output sopra dentro wrangler.toml (sotto [[kv_namespaces]])."
  else
    sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/${KV_ID}/" wrangler.toml && rm -f wrangler.toml.bak
    ok "wrangler.toml aggiornato con l'id del KV namespace."
  fi
else
  ok "KV namespace già configurato in wrangler.toml."
fi

info "Configurazione Backblaze B2"
echo "Se non hai ancora creato bucket e Application Key su B2, segui prima i passi 1-2 del README."
read -rp "B2 bucket name: " B2_BUCKET_VAL
read -rp "B2 endpoint (es. https://s3.us-west-004.backblazeb2.com): " B2_ENDPOINT_VAL
read -rp "B2 region (es. us-west-004): " B2_REGION_VAL
read -rp "B2 Application Key ID: " B2_KEY_ID_VAL
read -rsp "B2 Application Key (input nascosto): " B2_APP_KEY_VAL
echo

sed -i.bak \
  -e "s#REPLACE_WITH_BUCKET_NAME#${B2_BUCKET_VAL}#" \
  -e "s#https://REPLACE_WITH_YOUR_ENDPOINT#${B2_ENDPOINT_VAL}#" \
  -e "s#REPLACE_WITH_REGION#${B2_REGION_VAL}#" \
  wrangler.toml && rm -f wrangler.toml.bak
ok "wrangler.toml aggiornato con i valori B2 non sensibili."

cat > .dev.vars <<EOF
B2_KEY_ID=${B2_KEY_ID_VAL}
B2_APP_KEY=${B2_APP_KEY_VAL}
B2_BUCKET=${B2_BUCKET_VAL}
B2_ENDPOINT=${B2_ENDPOINT_VAL}
B2_REGION=${B2_REGION_VAL}
EOF
ok ".dev.vars scritto per lo sviluppo locale (è già in .gitignore)."

read -rp "Impostare B2_KEY_ID e B2_APP_KEY come secret su Cloudflare per il deploy? [y/N] " PUSH_SECRETS
if [[ "$PUSH_SECRETS" =~ ^[Yy]$ ]]; then
  printf '%s' "$B2_KEY_ID_VAL" | $WRANGLER secret put B2_KEY_ID
  printf '%s' "$B2_APP_KEY_VAL" | $WRANGLER secret put B2_APP_KEY
  ok "Secret impostati su Cloudflare."
else
  warn "Ricorda di impostarli prima del deploy con: npx wrangler secret put B2_KEY_ID  (e B2_APP_KEY)"
fi

read -rp "Eseguire 'wrangler deploy' ora? [y/N] " DO_DEPLOY
if [[ "$DO_DEPLOY" =~ ^[Yy]$ ]]; then
  $WRANGLER deploy
else
  ok "Setup completato. Esegui 'npm run deploy' quando sei pronto."
fi

info "Passi manuali rimanenti (non automatizzabili da qui):"
echo "  - Cloudflare Access (Zero Trust) su /admin, /api/invite, /api/upload — vedi README punto 6."
echo "  - SSE-B2 e lifecycle rule sul bucket B2, se non ancora fatto — vedi README punto 1."
