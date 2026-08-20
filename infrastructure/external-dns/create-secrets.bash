#!/bin/bash

ROOT=$(dirname "$0")

kubeseal -f $ROOT/gandi-pat.unsealed.yaml -w $ROOT/gandi-pat.sealed.yaml
kubeseal -f $ROOT/gandi-pilke-pat.unsealed.yaml -w $ROOT/gandi-pilke-pat.sealed.yaml
