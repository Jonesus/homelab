#!/bin/bash
set -euo pipefail

ROOT="$(dirname "$0")/prerequisites"

# Each one only if its unsealed input is on disk, so re-sealing one secret does
# not need the other written out again. Inputs are deleted after sealing.
seal() {
  if [[ -f "$ROOT/$1.unsealed.yaml" ]]; then
    kubeseal --format yaml -f "$ROOT/$1.unsealed.yaml" -w "$ROOT/$1.sealed.yaml"
    echo "sealed $1"
  fi
}

seal secrets
seal assets-mirror
