#!/bin/bash
set -euo pipefail

ROOT="$(dirname "$0")/prerequisites"

kubeseal --format yaml -f "$ROOT/secrets.unsealed.yaml" -w "$ROOT/secrets.sealed.yaml"
