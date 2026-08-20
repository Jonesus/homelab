#!/bin/bash

ROOT=$(dirname "$0")/prerequisites

kubeseal -f $ROOT/secrets.unsealed.yaml -w $ROOT/secrets.sealed.yaml
