#!/bin/bash

ROOT=$(dirname "$0")

/bin/bash $ROOT/argocd/install-argo.bash

kubectl apply -n argocd -f $ROOT/app.yaml
