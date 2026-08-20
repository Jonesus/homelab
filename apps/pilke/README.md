# Pilke

The `treffit-backend` API behind the Pilke dating app: `api.pilke.app` publicly,
`pilke.internal` on the LAN. Three processes off one image — gunicorn, a task
worker and a scheduler — a PostGIS database, and profile photographs in
[Garage](../garage/README.md), served at `/assets` on the API's own host.

None of these pods mount a volume. Photographs go to the bucket, sessions and
the task queue are in Postgres, and the collected static is baked into the
image, so a pod can be moved or replaced without detaching anything.

The manifests carry their own reasoning. This file is only the part that cannot
live in a comment: the order things have to happen in, and what is still open.

## Before the first sync

1. **Seal the secrets.** Copy each `prerequisites/*.unsealed.yaml.example` to
   `*.unsealed.yaml` (gitignored), fill it in, then run `./create-secrets.bash`
   and commit the sealed output. `prerequisites/` does not build until all three
   exist.

   `pilke-postgres-user` and `pilke-app-secrets` need nothing from anywhere —
   both are generated. `ghcr-pull` needs a GitHub token with `read:packages`,
   and it is the only one that cannot be produced from this repository.
2. **Bootstrap Garage**, following [its README](../garage/README.md): assign
   the layout, create the `assets` bucket, allow website access on it, and mint
   the key. Step 4 there prints the credentials that go into
   `app-secrets.unsealed.yaml` here, so it has to happen before these secrets
   are sealed.
3. **Back up the sealed-secrets controller key**, if it has not been done. This
   is a cluster-wide gap rather than a Pilke one, and it is what decides whether
   a rebuild can decrypt anything in this repo — including the database
   credential you would be restoring with:
   ```bash
   kubectl -n kube-system get secret \
     -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
     -o yaml > sealed-secrets-key.yaml   # then offline, into the password manager
   ```

## First deploy, in order

Each step's check is what says it worked.

1. **`prerequisites` syncs** (wave `-1`): namespace, secrets, CNPG cluster, the
   two PVCs. This is where a PostGIS problem surfaces, and it surfaces cheaply.
   ```bash
   kubectl -n pilke get cluster
   kubectl -n pilke exec pilke-postgres-1 -- psql treffit -c 'select postgis_version()'
   ```
2. **`app` syncs**, LAN only — `ingress.yaml` is not in `kustomization.yaml`
   yet. The PreSync job migrates and creates the cache table, then the three
   Deployments roll. Check over **https**, not http:
   - `https://pilke.internal/admin/` renders **with CSS** (proves WhiteNoise is
     serving the static baked into the image), and a login sticks across a
     refresh (proves the cookie and proxy settings);
   - a photograph uploaded through the API comes back over `/assets/...`. That
     one request exercises the whole chain — `SameOriginS3Storage` returning a
     path rather than a bucket URL, the `/assets` Ingress rewriting it, and
     Garage's web endpoint answering anonymously — and nothing else does;
   - `kubectl -n pilke logs deploy/pilke-scheduler` shows `Scheduling 4 periodic job(s)`.
3. **Seed.**
   ```bash
   kubectl -n pilke exec deploy/pilke-api -c api -- python manage.py seed_admin
   kubectl -n pilke exec deploy/pilke-api -c api -- python manage.py seed_reference_data
   kubectl -n pilke exec deploy/pilke-api -c api -- python manage.py seed_feedback
   ```
   `seed_reference_data` writes the `Language` rows every translated string hangs
   off — without them `GET /api/surveys` 500s rather than serialising.
   ⚠️ It deliberately writes **no `Activity` rows**, and that is the design: an
   activity is a real bar at real coordinates that a stranger will be asked to
   stand outside on a Friday. Until real venues are loaded, every candidate draw
   answers 404 "exhausted" — which is also its answer for the ordinary case of
   nobody compatible being free, so it will not look like missing content. Do
   **not** reach for `mockdata`; it also invents ten users with `dog.jpg`.
4. **Go public — DNS first, then one commit.** Confirm `api.pilke.app` resolves
   (external-dns now carries `--domain-filter=pilke.app`; Let's Encrypt solves
   HTTP-01 through nginx, so the name must resolve before a certificate can
   issue). Then, in a single commit: add `ingress.yaml` to `kustomization.yaml`,
   uncomment `SMS_BACKEND` in `configmap.yaml`, and add `GATEWAYAPI_TOKEN` to
   the sealed secret. Watch `kubectl -n pilke get certificate`.
   ```bash
   # the code must NOT come back in the body, and the SMS must arrive
   curl -si https://api.pilke.app/api/auth/login -d '{"phone_number":"+3584..."}'
   # and a second request 5 seconds later must be a 429
   ```
5. **Rehearse a restore**, below, before any real user exists.
6. **Point the app at it.** `EXPO_PUBLIC_API_URL` is inlined into the JS bundle
   at build time, so it is a build input rather than configuration: set the repo
   variable in `pilke-app` to `https://api.pilke.app` and rebuild.

## Steady state

CI pushes `sha-<7>`; bump that tag in the four places it appears under `app/`
and commit. Argo runs `pilke-migrate`, then rolls the Deployments. One commit
per deploy, and the tag in git is the record of what is running.

Migrations do not un-apply when you revert the tag. Keep them
backwards-compatible — additive columns, no drop in the same release that stops
writing them — and for anything destructive, take a dump first: the rollback is
restore-from-dump, not `git revert`.

## What this deployment does not give you

- ⚠️ **Backups. There are none.** Nothing dumps the database, nothing snapshots
  its volume, and nothing mirrors the photographs out of Garage. That is
  deliberate for a first sync and **must not still be true when a real person
  registers** — a beta that loses its users' data does not get a second beta.
  The follow-up adds them, along with the restore drill that is the actual
  deliverable.
- **One of everything that holds state.** The API runs two replicas and rolls
  without downtime, but `pilke-postgres`, Garage, the worker and the scheduler
  are single and their restarts are visible. The database is the one that
  matters: a node drain moves it, and it cannot come back until the iSCSI volume
  detaches and reattaches.
- **One NAS.** The database volume, Garage's volume and the backups are all on
  it. This protects against a bad migration, not against losing the box.
- **No monitoring.** "The outbox stopped draining" is discoverable only by
  reading task results in the admin, and "the API is down" only by a user
  saying so. The cheapest fix is an **external** uptime check on
  `https://api.pilke.app/healthz` — external because when the ISP is down,
  anything in-cluster is down with it — plus a dead-man's-switch ping from the
  backup CronJob, since a silently failing backup is how backups actually fail.
- **No offsite copy**, and no answer yet on whether the disks are encrypted at
  rest. The second one changes what the privacy statement can honestly claim.

This app arranges in-person meetings between strangers. If the backend is down
at 19:40 on a Friday, somebody standing outside a bar cannot check where their
date is, cannot cancel, and cannot reach the safety copy. A fair expectation
here is a few hours of unavailability a month, mostly around your own
maintenance — so schedule maintenance on a Tuesday morning, not an evening.
