#!/bin/bash

ROOT=$(dirname "$0")/prerequisites

kubeseal -f $ROOT/database-user.unsealed.yaml -w $ROOT/database-user.sealed.yaml
kubeseal -f $ROOT/app-secrets.unsealed.yaml -w $ROOT/app-secrets.sealed.yaml
kubeseal -f $ROOT/ghcr-pull.unsealed.yaml -w $ROOT/ghcr-pull.sealed.yaml
