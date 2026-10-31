# Restore drill

A backup that has never been restored is a hope. This is the procedure that turns
it into a measured fact: restore `pilke-postgres` from the QNAP into a scratch
namespace, prove the copy matches production, write down how long it took, and
delete it.

Do it once as soon as backups are live, then after anything that changes the
backup path (a plugin, operator or Garage bump, the NetworkPolicy stage 2
rollout), and otherwise every quarter.

Nothing in this directory is synced by Argo. Every step is a `kubectl` command,
run from the repository root, against the production cluster. It reads the
production backups and never writes to them, and it never touches
`pilke-postgres` except for one `psql` session in step 2.

## 0. Preconditions

```bash
kubectl -n pilke get backups                         # at least one, PHASE completed
kubectl cnpg status pilke-postgres -n pilke          # archiving: no failed WAL, a recent last archived
```

If WAL archiving is failing, stop here: the restore would be missing whatever
has not been archived, and fixing the archive comes first.

## 1. The scratch namespace

```bash
kubectl apply -f apps/pilke/restore-drill/namespace.yaml

# The two Secrets the ObjectStore reads, copied out of `pilke` with nothing but
# their data. A SealedSecret is bound to its namespace, so this is a copy of the
# decrypted Secret, and it is deleted with the namespace in step 6.
kubectl -n pilke get secret pilke-backup-s3 pilke-backup-endpoint-ca -o json \
  | jq '{apiVersion: "v1", kind: "List", items: [.items[]
        | {apiVersion, kind, type, data,
           metadata: {name: .metadata.name, namespace: "pilke-restore-drill"}}]}' \
  | kubectl apply -f -

kubectl apply -f apps/pilke/restore-drill/object-store.yaml
```

## 2. Mark a point on production, and count what is there

One `psql` session against the primary. It creates a named restore point and
takes exact row counts **from the same snapshot**: in a `repeatable read`
transaction the snapshot is taken by the first statement, which is the one that
writes the restore point, so the two describe the same instant to within
microseconds. Then `pg_switch_wal()` closes the WAL segment holding the point,
so it is archived now rather than within five minutes.

```bash
DRILL="drill-$(date -u +%Y%m%dT%H%M%SZ)"
PRIMARY=$(kubectl -n pilke get pod -o name \
  -l cnpg.io/cluster=pilke-postgres,cnpg.io/instanceRole=primary)

{ echo "begin isolation level repeatable read;"
  echo "select pg_create_restore_point('$DRILL');"
  cat apps/pilke/restore-drill/row-counts.sql
  echo "commit;"
  echo "select pg_switch_wal();"
} | kubectl -n pilke exec -i "$PRIMARY" -c postgres -- psql -X -q -At treffit \
  > /tmp/"$DRILL"-production.txt

echo "$DRILL"; head /tmp/"$DRILL"-production.txt
```

The file has a WAL position on its first line and its last, and the counts in
between.

The newest base backup that finished before the point is the `backupID` the
restore needs:

```bash
kubectl -n pilke get backups \
  -o custom-columns=NAME:.metadata.name,ID:.status.backupId,PHASE:.status.phase,STOPPED:.status.stoppedAt \
  --sort-by=.status.stoppedAt
```

## 3. Restore

Point-in-time, to the restore point from step 2. Edit `cluster-pitr.yaml`:
`backupID` from the table above, `targetName` the `$DRILL` value. Then:

```bash
kubectl apply -f apps/pilke/restore-drill/cluster-pitr.yaml
START=$(date +%s)
kubectl -n pilke-restore-drill get pods -w     # a -full-recovery Job, then -1
kubectl -n pilke-restore-drill wait cluster/pilke-postgres-drill \
  --for=condition=Ready --timeout=60m
echo "restore took $(( $(date +%s) - START ))s"
```

The other two shapes, for practice or for a real incident:

- **Latest:** `cluster.yaml` instead, with no target. It restores the newest base
  backup and replays every archived segment after it.
- **A time:** in `cluster-pitr.yaml`, replace the two `REPLACE-ME` lines with
  `targetTime: "2026-11-03 09:40:00+02:00"`. CNPG picks the base backup itself.
  Recovery stops at the last transaction that committed before that moment.

If the recovery Job fails, its log is the explanation, and an object-store error
there names the call that failed:

```bash
kubectl -n pilke-restore-drill logs job/pilke-postgres-drill-1-full-recovery --all-containers
```

## 4. Verify

```bash
kubectl -n pilke-restore-drill exec -i pilke-postgres-drill-1 -c postgres -- \
  psql -X -q -At treffit < apps/pilke/restore-drill/row-counts.sql \
  > /tmp/"$DRILL"-restored.txt

diff <(sed '1d;$d' /tmp/"$DRILL"-production.txt) /tmp/"$DRILL"-restored.txt \
  && echo "IDENTICAL"
```

`sed '1d;$d'` drops the two WAL positions the production file starts and ends
with. **The diff must be empty.** Every table, the last migration and the PostGIS
version match, or the drill has found something, which is what it is for.

A row-count match does not prove the application can use the copy. Two more
checks that cost a minute:

```bash
PSQL="kubectl -n pilke-restore-drill exec -i pilke-postgres-drill-1 -c postgres -- psql -X treffit"
# The role the application logs in as came back with its grants.
$PSQL -c '\du treffit'
# A geography calculation, which only answers if PostGIS loaded in `treffit`.
$PSQL -c "select st_distance('POINT(24.94 60.17)'::geography, 'POINT(24.95 60.17)'::geography);"
```

## 5. Write it down

Append a row to the log at the bottom of this file and commit it. The duration is
the number that matters: it is how long Pilke would be down for this step alone
in a real restore.

## 6. Tear down

```bash
kubectl delete namespace pilke-restore-drill
kubectl get pv | grep pilke-restore-drill      # nothing: `iscsi` is reclaimPolicy Delete
rm /tmp/"$DRILL"-*.txt
```

The copied Secrets, the ObjectStore and the restored database's volume go with
the namespace. The files in `/tmp` hold table names and counts, not data, but
there is no reason to keep them.

## Before production depends on it: prove the store

Run this once, after `apps/garage-backup` is bootstrapped and before
`../prerequisites/backup/` is turned on. It archives an empty throwaway cluster
into the store, which is the step that would otherwise be tried first on the
production database.

The Secrets do not exist in `pilke` yet at this point, so they come from the
unsealed file and from the Certificate manifest, with the namespace rewritten:

```bash
kubectl apply -f apps/pilke/restore-drill/namespace.yaml
sed 's/namespace: pilke$/namespace: pilke-restore-drill/' \
  apps/pilke/prerequisites/backup/backup-s3.unsealed.yaml | kubectl apply -f -
sed 's/namespace: pilke$/namespace: pilke-restore-drill/' \
  apps/pilke/prerequisites/backup/endpoint-ca.yaml | kubectl apply -f -
kubectl apply -f apps/pilke/restore-drill/object-store.yaml
kubectl apply -f apps/pilke/restore-drill/proof-cluster.yaml

kubectl -n pilke-restore-drill wait cluster/backup-proof --for=condition=Ready --timeout=10m
kubectl cnpg backup backup-proof -n pilke-restore-drill \
  --method=plugin --plugin-name=barman-cloud.cloudnative-pg.io
kubectl -n pilke-restore-drill get backups -w   # PHASE: completed
kubectl cnpg status backup-proof -n pilke-restore-drill   # archiving: no failed WAL

kubectl delete namespace pilke-restore-drill
```

A `completed` backup and a working archive mean the TLS listener, the CA, the
key, the region, the checksum settings and Garage's S3 dialect all agree with
barman-cloud. Its objects stay under `s3://pilke-postgres/backup-proof/`, a few
megabytes beside production's and never mixed with them.

## When it is not a drill

The same manifests restore production, with three differences.

- **Where to restore to.** The drill restores onto `iscsi`, which is the TrueNAS.
  If the TrueNAS is the thing that was lost, that StorageClass is gone with it,
  and this cluster has no other dynamic storage: the QNAP has no CSI driver
  (`qnap-iscsi` exists as a class with no driver behind it). The real-disaster
  path is therefore "restore onto whatever storage exists by then", and deciding
  what that is in advance is still open.
- **The name.** Restore into `pilke` as `pilke-postgres` again, after the broken
  Cluster and its volume are gone, so `pilke-postgres-rw` and every Deployment's
  `DATABASE_HOST` keep working. Add `plugins:` with a **new `serverName`**
  parameter (for example `pilke-postgres-2`): CNPG refuses to archive into a
  path that already holds another timeline's WAL, and the old path is the history
  you just restored from.
- **The application.** Scale `pilke-api`, `pilke-worker` and `pilke-scheduler`
  to zero before the restore and back afterwards, so nothing writes to a
  database that is about to be replaced. A restore to a point before a migration
  also needs the image tag that matches it; see "Steady state" in `../README.md`.

## Log

| Date (UTC) | Who | Target | Base backup | Restore took | Diff | Notes |
|---|---|---|---|---|---|---|
| 2026-10-31 17:45 | Claude Code, for Joonas | `drill-20261031T174454Z` (PITR) | `20261031T174211` | 95 s | empty, 61 counts | First drill, right after backups went live. `treffit` role and PostGIS checked. |
