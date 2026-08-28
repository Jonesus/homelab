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

### The secrets

Write each one as `prerequisites/<name>.unsealed.yaml` — `*.unsealed.yaml` is
gitignored — then run `./create-secrets.bash` and commit only the sealed output.
`prerequisites/` does not build until all three exist.

**`database-user.unsealed.yaml`.** CNPG reads this at bootstrap (`initdb.secret`)
to create the role, and the Deployments read the same two keys as
`POSTGRES_USER` and `POSTGRES_PASSWORD` — one copy of the credential, unlike
miniflux and paperless which also seal a whole connection string beside it.
Generate the password with `openssl rand -hex 32`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: pilke-postgres-user
  namespace: pilke
type: kubernetes.io/basic-auth
stringData:
  username: treffit
  password: ""
```

**`app-secrets.unsealed.yaml`.** Only `SECRET_KEY` is needed to sync; the rest
arrive as they are obtained, and a key that is **absent** behaves as its default
while an empty string does not always. `settings.py` has no default for
`SECRET_KEY`, so a missing one fails loudly at import rather than signing with a
known value — generate it with
`python -c "import secrets; print(secrets.token_urlsafe(64))"`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: pilke-app-secrets
  namespace: pilke
type: Opaque
stringData:
  SECRET_KEY: ""

  # From `garage key create pilke` — see ../garage/README.md. boto3 reads these
  # from the environment, which is why they are not in MEDIA_STORAGE_OPTIONS,
  # where they would be a ConfigMap holding a secret.
  AWS_ACCESS_KEY_ID: ""
  AWS_SECRET_ACCESS_KEY: ""

  # Expo push. Without it, notifications are accepted and never delivered.
  EXPO_ACCESS_TOKEN: ""

  # GatewayAPI, EU platform. Safe to seal before SMS is switched on — it is read
  # only when `SMS_BACKEND` names that backend, and having it here first is what
  # makes flipping that one line safe. ⚠️ The reverse is the dangerous order: the
  # backend selected with an empty token FAILS every login rather than falling
  # back to echoing the code, which is the safety property but a poor surprise.
  GATEWAYAPI_TOKEN: ""

  # What `seed_admin` reads. The phone number is a real login identity: with SMS
  # live, it is where the admin's one-time codes are texted.
  DJANGO_SUPERUSER_PHONE_NUMBER: ""
  DJANGO_SUPERUSER_PASSWORD: ""
  DJANGO_SUPERUSER_EMAIL: ""
  DJANGO_SUPERUSER_NICKNAME: ""
  DJANGO_SUPERUSER_GENDER: "other"
  DJANGO_SUPERUSER_BIRTHDAY: "1970-01-01"
  DJANGO_SUPERUSER_DATE_LOCATION_PREFERENCE: "POINT(24.94 60.17)"
  DJANGO_SUPERUSER_DATE_LOCATION_PREFERENCE_RADIUS: "5"
```

**`ghcr-pull.unsealed.yaml`.** The only one that cannot be produced from this
repository. `ghcr.io/boissit/treffit-backend` is private and has to stay private
— the image is `COPY ./ /app` of the source — and no other app here needs a pull
secret. Use a **classic** token with `read:packages` and nothing else;
fine-grained tokens are unreliable for reading an organisation's packages.

```bash
kubectl create secret docker-registry ghcr-pull --namespace pilke \
  --docker-server=ghcr.io --docker-username=<github-username> \
  --docker-password=<token> \
  --dry-run=client -o yaml > prerequisites/ghcr-pull.unsealed.yaml
```

⚠️ Write the token's expiry down somewhere you will see it. When it lapses every
pod fails with `ImagePullBackOff` and nothing else explains why.

### And two things around them

1. **Bootstrap Garage** first, following [its README](../garage/README.md): the
   S3 key does not exist until it has been minted, and it belongs in
   `app-secrets.unsealed.yaml` above.
2. **Back up the sealed-secrets controller key**, if it has not been done. A
   cluster-wide gap rather than a Pilke one, and it decides whether a rebuild can
   decrypt anything in this repo — including the database credential you would be
   restoring with:
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
   - a photograph uploaded through the API comes back over `/assets/...` with an
     `X-Amz-Signature` on it, and opening that URL returns the image. That one
     request exercises the whole chain — the upload going to Garage's S3 API over
     the cluster network, `SameOriginS3Storage` signing for `api.pilke.app`
     instead, the `/assets` Ingress passing Host and path through untouched, and
     Garage verifying the signature — and nothing else does. Trimming the query
     string off that URL must answer **403**: that is the anonymous read being
     refused, which is the whole point (`Jonesus/homelab#4`);
   - `kubectl -n pilke logs deploy/pilke-scheduler` shows `Scheduling 5 periodic job(s)`.
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
4. **Go public — one commit, then restart.** ⚠️ The Deployments read the
   ConfigMap with `envFrom`, resolved once at pod start, and Argo does not roll a
   Deployment because a ConfigMap changed. So `SMS_BACKEND` is not in effect
   until:
   ```bash
   kubectl -n pilke rollout restart deploy/pilke-api deploy/pilke-worker deploy/pilke-scheduler
   ```
   Until that runs, the login endpoint is still handing out one-time codes in its
   response body while the manifest says otherwise. Confirm `api.pilke.app` resolves
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

Bump `sha-<7>` in the four places it appears under `app/` — the three Deployments
and the migration Job — and commit. Argo runs `pilke-migrate` as a `PreSync`
hook, which applies migrations and `createcachetable`, then rolls the
Deployments. One commit per deploy, and the tag in git is the record of what is
running.

⚠️ **CI does not build that image right now.** Every Actions job in the `boissit`
organisation has failed at zero steps since 16 August 2026 with a billing
annotation, so images are built and pushed by hand, with the gate CI would have
applied applied by hand too. The procedure is
[`docs/releasing.md`](https://github.com/boissit/treffit-backend/blob/main/docs/releasing.md)
in `treffit-backend`; tracked as boissit/pilke-app#54.

⚠️ **A ConfigMap change needs a restart and Argo will not tell you.**
`prerequisites/configmap.yaml` is read with `envFrom`, resolved once at pod
start, so a commit to it reports Synced *and* Healthy with the old values still
live:

```bash
kubectl -n pilke rollout restart deploy/pilke-api deploy/pilke-worker deploy/pilke-scheduler
```

Check what is running rather than what was committed — `/healthz` answering 200
proves the database is reachable and nothing about which image or which config:

```bash
kubectl -n pilke get pods -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}' | sort -u
kubectl -n pilke exec deploy/pilke-api -c api -- printenv SMS_BACKEND
```

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
- **No monitoring from outside the cluster.** Telemetry itself is here —
  `observability.yaml` and `observability-charts.yaml` deploy VictoriaLogs,
  VictoriaTraces, Grafana at `pilke-o11y.internal` and five alert rules that
  reach a phone through Alertmanager and Home Assistant. What none of it can do
  is report on losing the thing it runs on: its volumes are on the same NAS as
  the database, its dead man's switch dies with the cluster, and when the ISP is
  down so is every part of it. So the **external** uptime check on
  `https://api.pilke.app/healthz` is still owed, plus a dead-man's-switch ping
  from the backup CronJob, since a silently failing backup is how backups
  actually fail.
- **No offsite copy**, and no answer yet on whether the disks are encrypted at
  rest. The second one changes what the privacy statement can honestly claim.

This app arranges in-person meetings between strangers. If the backend is down
at 19:40 on a Friday, somebody standing outside a bar cannot check where their
date is, cannot cancel, and cannot reach the safety copy. A fair expectation
here is a few hours of unavailability a month, mostly around your own
maintenance — so schedule maintenance on a Tuesday morning, not an evening.
