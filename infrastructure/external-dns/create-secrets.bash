#!/bin/bash

ROOT=$(dirname "$0")

kubeseal -f $ROOT/gandi-pat.unsealed.yaml -w $ROOT/gandi-pat.sealed.yaml
