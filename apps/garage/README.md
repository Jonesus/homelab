# Garage

A single-node S3-compatible object store. Today it holds one thing: the profile
photographs `pilke-api` uploads and the `/assets` route on `api.pilke.app`
serves.

Chosen over MinIO, whose upstream was archived in February 2026 — what remains
is community forks — and over SeaweedFS, which is a four-component deployment
for a job this size and has an open barman-cloud incompatibility. Garage is one
binary and one volume.

## The secret

`prerequisites/secrets.unsealed.yaml`, sealed with `./create-secrets.bash`.
`*.unsealed.yaml` is gitignored; only the sealed output is committed.

⚠️ `rpc-secret` must be **exactly** 32 bytes of hex — `openssl rand -hex 32`.
Garage refuses to start on anything else. `admin-token` is free-form;
`openssl rand -base64 32`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: garage-secrets
  namespace: garage
type: Opaque
stringData:
  rpc-secret: ""
  admin-token: ""
```

The S3 access key for Pilke is **not** here. Garage mints its own, so it does not
exist until the bootstrap below has run — and it is sealed into `apps/pilke`
rather than into this namespace, because that is where it is read.

## Bootstrap, once

⚠️ **A fresh Garage does nothing until its layout is assigned.** Until then every
S3 call fails in a way that reads as a bad credential rather than as an
uninitialised store, which is a bad half-hour if you do not know.

```bash
G="kubectl -n garage exec -it garage-0 -- /garage"

# 1. The node's own id, which the layout is assigned to.
$G status

# 2. Give it a zone and a capacity, then commit. The capacity is what Garage
#    spreads data by; with one node it only has to be non-zero and no larger
#    than the PVC.
$G layout assign -z home -c 30G <node-id>
$G layout apply --version 1

# 3. The bucket. **Website access stays off**: it is the only way an
#    unauthenticated GET can reach an object, since Garage implements no bucket
#    policies or ACLs — see the note below.
$G bucket create assets

# 4. A key for Pilke, and read+write on that bucket only.
$G key create pilke
$G bucket allow --read --write assets --key pilke
```

## ⚠️ The `assets` bucket is private, and that is not in any manifest

Pilke's photographs are served through presigned URLs — signed by the API,
expiring after seven days — and the boundary that makes signing worth anything is
this bucket refusing anonymous reads:

```bash
$G bucket website --deny assets     # the state it is in
$G bucket website --allow assets    # the rollback, and the old behaviour
```

**A rebuild from these manifests alone would come back public.** `garage bucket
website` is a CLI call against the running pod and there is nothing here that
expresses it, which is exactly why it is written down.

What the deny closes, precisely: with `/assets` routed to the S3 API, the public
unsigned path already 403s whatever this flag says — the flag governs the web
endpoint on 3902, and no Ingress points there any more. Anonymous reads were
still reachable from **inside** the cluster (measured: 200, with
`Host: assets.web.garage.internal`), and an Ingress pointed back at 3902 would
silently reopen them. This is the boundary; the route is what stops the address
being permanent. `Jonesus/homelab#4` is the
change, `apps/pilke/app/assets-route.yaml` is the route that reaches the S3 API
instead of the web endpoint, and `MEDIA_SIGNED_URLS` in Pilke's ConfigMap is the
half that stops handing out permanent addresses.

Undoing it is both halves in the other order: allow the website again, unset
`MEDIA_SIGNED_URLS`, restart the pods. Photograph URLs already in a phone's
persisted cache keep working either way — the app tolerates both shapes.

Step 4 prints an access key id and a secret. They go into
`apps/pilke/prerequisites/app-secrets.unsealed.yaml` as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, sealed from there — not into this namespace, because
`pilke-api` is what reads them.

Check it end to end from the API's side:

```bash
kubectl -n pilke exec deploy/pilke-api -c api -- \
  python manage.py shell -c "
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
name = default_storage.save('users/_probe.txt', ContentFile(b'ok'))
print(name, default_storage.url(name))
"
```

The printed URL must be a **path** — `/assets/users/_probe...` — and not an
absolute one. If it is absolute, `MEDIA_STORAGE_BACKEND` is not naming
`SameOriginS3Storage` and every photograph in the app will 404 against a URL
with two schemes in it. Delete the probe afterwards.

## What this is not

- **Not replicated, and not yet backed up.** One node,
  `replication_factor = 1`, and nothing copies the bucket anywhere. Durability
  today is the NAS's pool and nothing else, which is fine while the only
  photographs in here are yours.
- **Not multi-tenant.** One bucket, one key. A second app wanting storage gets
  its own of each, not a share of these.
- **Not a WAL archive — yet.** It could be: CloudNativePG can only archive WAL
  to an object store, and one now exists, which is the difference between the
  nightly snapshot's recovery point and a real point-in-time one. It is not
  wired up because barman-cloud's compatibility with anything that is not AWS or
  MinIO has a poor record, and that is worth proving on a scratch cluster before
  the database depends on it.
