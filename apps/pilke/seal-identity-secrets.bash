#!/bin/bash
#
# Seals the three identity-verification secrets into pilke-app-secrets, merging
# them into the existing SealedSecret so nothing else in it changes.
#
#   ./apps/pilke/seal-identity-secrets.bash <dir>
#   # commit prerequisites/app-secrets.sealed.yaml, push, wait for Argo, then
#   # restart the api, worker and scheduler (a Secret change rolls nothing)
#
# <dir> holds one file per value, each a single line:
#   didit-live-key              -> DIDIT_API_KEY
#   didit-live-webhook-secret   -> DIDIT_WEBHOOK_SECRET
#   identity-hash-keys          -> IDENTITY_HASH_KEYS (k1:<base64 of 32 bytes>)
#
# Runs against the cluster's controller, or offline with the controller's public
# certificate in sealed-secrets-cert.pem beside this script (fetch it once with
# `kubeseal --fetch-cert`; it is a public key and safe to commit).
#
# No value is printed or put in an argument list: they go from the files into a
# Secret manifest on stdin and from there into kubeseal.
#
# ⚠️ Back identity-hash-keys up OUTSIDE the cluster before sealing it. Losing it
# loses every one-account-per-person rule and every identity ban, with no way back.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SEALED="$ROOT/prerequisites/app-secrets.sealed.yaml"
CERT="$ROOT/sealed-secrets-cert.pem"

[[ $# -eq 1 && -d "$1" ]] || { echo "usage: $0 <dir with the three files>" >&2; exit 2; }
DIR="$(cd "$1" && pwd)"

for f in didit-live-key didit-live-webhook-secret identity-hash-keys; do
  [[ -s "$DIR/$f" ]] || { echo "Missing or empty: $DIR/$f" >&2; exit 1; }
done

grep -Eq '^k[0-9]+:[A-Za-z0-9+/=]{43,}$' "$DIR/identity-hash-keys" ||
  { echo "identity-hash-keys is not k<n>:<base64 of at least 32 bytes>." >&2; exit 1; }

cert_args=()
[[ -f "$CERT" ]] && cert_args=(--cert "$CERT")

python3 - "$DIR" <<'EOF' |
import base64, json, sys
from pathlib import Path
d = Path(sys.argv[1])
files = {
    "DIDIT_API_KEY": "didit-live-key",
    "DIDIT_WEBHOOK_SECRET": "didit-live-webhook-secret",
    "IDENTITY_HASH_KEYS": "identity-hash-keys",
}
data = {k: base64.b64encode((d / f).read_text().strip().encode()).decode() for k, f in files.items()}
print(json.dumps({
    "apiVersion": "v1", "kind": "Secret",
    "metadata": {"name": "pilke-app-secrets", "namespace": "pilke"},
    "data": data,
}))
EOF
  kubeseal "${cert_args[@]}" --format yaml --merge-into "$SEALED"

echo "Merged DIDIT_API_KEY, DIDIT_WEBHOOK_SECRET and IDENTITY_HASH_KEYS into $SEALED."
echo "Commit it, push, wait for Argo, then restart api, worker and scheduler."
