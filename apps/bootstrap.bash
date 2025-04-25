#!/bin/bash

ROOT=$(dirname "$0")

kubectl apply -n argocd -f $ROOT/project.yaml
kubectl apply -n argocd -f $ROOT/app.yaml
