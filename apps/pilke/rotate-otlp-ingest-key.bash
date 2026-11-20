#!/bin/bash
#
# Mints the app's OTLP ingest key, seals it for the collector, and writes the same
# value into pilke-app's `eas.json`, so store builds and updates carry it. Also the
# whole of revoking one: run it again.
#
#   ./apps/pilke/rotate-otlp-ingest-key.bash seal ../pilke-app
#   # commit observability/otlp-ingest-key.sealed.yaml here and eas.json there,
#   # push this repository and wait for Argo to sync pilke-observability, then
#   ./apps/pilke/rotate-otlp-ingest-key.bash restart ../pilke-app
#
# The key is never printed. It goes from `openssl` into `kubectl` on stdin and into
# `node` through the environment, and the check at the end hands it to `curl` as a
# header file, so it is in no argument list either.
#
# ⚠️ THE KEY IS OBFUSCATION AND NOT A SECRET, as `collector-config.yaml` says: it
# ships in the JS bundle. Sealing it keeps it out of this public repository's
# history; the Ingress rate limits are what bound abuse.
#
# ⚠️ ROTATING CUTS OFF EVERY BUILD THAT HOLDS THE OLD KEY until an update or a
# build with the new one reaches it. The collector accepts one token. Between
# `restart` and the next update on each channel, phones get 401 and their spans
# are lost, which is the point when the old key is being revoked.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SEALED="$ROOT/observability/otlp-ingest-key.sealed.yaml"
URL="https://api.pilke.app/otlp/v1/traces"

usage() {
  echo "usage: $0 seal|restart <path to the pilke-app checkout>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
mode="$1"
EAS="$(cd "$2" && pwd)/eas.json"
[[ -f "$EAS" ]] || { echo "No eas.json at $EAS." >&2; exit 1; }

# The key as eas.json holds it, without the `Bearer ` scheme. Only ever piped.
key_in_eas() {
  node -e '
const env = require(process.argv[1]).build?.production?.env ?? {};
const value = env.EXPO_PUBLIC_OTLP_KEY ?? "";
if (!value.startsWith("Bearer ")) process.exit(1);
process.stdout.write(value.slice("Bearer ".length));
' "$EAS"
}

case "$mode" in
  seal)
    key="$(openssl rand -hex 32)"

    printf '%s' "$key" |
      kubectl create secret generic pilke-otlp-ingest-key --namespace pilke \
        --from-file=OTLP_INGEST_KEY=/dev/stdin --dry-run=client -o yaml |
      kubeseal --format yaml >"$SEALED.new"
    mv "$SEALED.new" "$SEALED"

    # The production profile only: `staging` extends it and must not get an `env`
    # of its own (pilke-app docs/releasing.md), and `publish-update.sh` reads
    # through `extends` the same way.
    OTLP_KEY="$key" OTLP_URL="$URL" node -e '
const fs = require("node:fs");
const file = process.argv[1];
const eas = JSON.parse(fs.readFileSync(file, "utf8"));
Object.assign(eas.build.production.env, {
  EXPO_PUBLIC_OTLP_URL: process.env.OTLP_URL,
  EXPO_PUBLIC_OTLP_KEY: "Bearer " + process.env.OTLP_KEY,
});
fs.writeFileSync(file, JSON.stringify(eas, null, 2) + "\n");
' "$EAS"
    unset key

    echo "Sealed a new key into $SEALED and wrote it into $EAS."
    echo "Commit both, push this repository, wait for Argo to sync"
    echo "pilke-observability, then run: $0 restart $2"
    ;;

  restart)
    want="$(key_in_eas | shasum -a 256)" ||
      { echo "eas.json has no 'Bearer ' EXPO_PUBLIC_OTLP_KEY in the production profile." >&2; exit 1; }

    # The controller unseals within seconds of Argo applying the SealedSecret.
    # Restarting before that would start the gateway on the old key.
    have=""
    for _ in $(seq 60); do
      have="$(kubectl -n pilke get secret pilke-otlp-ingest-key \
        -o jsonpath='{.data.OTLP_INGEST_KEY}' | base64 -d | shasum -a 256)"
      [[ "$have" == "$want" ]] && break
      sleep 10
    done
    [[ "$have" == "$want" ]] ||
      { echo "The cluster's Secret still differs from eas.json after ten minutes. Has Argo synced?" >&2; exit 1; }

    # A Secret change does not roll a Deployment, and the key is read at startup.
    kubectl -n pilke rollout restart deploy/otel-collector
    kubectl -n pilke rollout status deploy/otel-collector --timeout=5m

    # The proof from outside, as the first deployment of this path was checked: no
    # key is refused, the new key is accepted.
    post() {
      curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        --data '{"resourceSpans":[]}' "$@" "$URL"
    }
    without="$(post)"
    with="$(post -H @<(printf 'Authorization: Bearer %s\n' "$(key_in_eas)"))"
    echo "no key: $without (want 401), new key: $with (want 200)"
    [[ "$without" == 401 && "$with" == 200 ]]
    ;;

  *)
    usage
    ;;
esac
