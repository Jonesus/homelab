# Garage, backup store

A second single-node Garage, holding one thing: `pilke-postgres`'s WAL archive and
base backups, written by the CloudNativePG Barman Cloud plugin
(`infrastructure/cnpg-barman-cloud`) and configured in
`apps/pilke/prerequisites/backup/`.

It exists because of where its volume is. This cluster has two NAS boxes:

| | Address | What the cluster uses it for |
|---|---|---|
| **TrueNAS** | 192.168.1.111 (pool `ssdpool`)¹ | every dynamic volume: democratic-csi `iscsi` (the Pilke database, `../garage`, the telemetry stores, immich, paperless and miniflux Postgres), plus the NFS target of `../backup-photos` |
| **QNAP TS-469 Pro** | 192.168.1.103 | NFS shares (`/photos`, `/cluster/calibre`, `/cluster/paperless`); its iSCSI LUNs were retired in 26db777 |

¹ The address democratic-csi talks to is inside its sealed config, so .111 is the
TrueNAS's NFS address from `../backup-photos` rather than something read from the
iSCSI setup.

The database is on the TrueNAS. This store's data is on an NFS export from the
QNAP, so losing either box leaves one copy. Neither NAS offers an S3 endpoint of
its own that anything here uses, which is why this is a Garage in the cluster
rather than a URL.

Same image and the same CLI as `../garage`, so that README's commands carry over
with a different namespace. Three things differ, and each is argued in the
manifest that does it: **sqlite** instead of LMDB because the metadata is on NFS
(`app/configmap.yaml`), **TLS** in front of the S3 API (`app/statefulset.yaml`),
and **no web endpoint** at all.

## Before the first sync

### 1. The directory on the QNAP

`app/data-pv.yaml` mounts `192.168.1.103:/cluster/pilke-backup`. Create it in the
same `cluster` share that calibre and paperless already use, and make it
writable by uid 1000, which is what Garage runs as. Over SSH on the QNAP:

```bash
mkdir /share/cluster/pilke-backup
chown 1000:1000 /share/cluster/pilke-backup
chmod 700 /share/cluster/pilke-backup
```

Then, in the QNAP's NFS host access settings for the `cluster` share, check that
only the cluster nodes' addresses are allowed. **That list is the only access
control on these files.** NFSv4 with `sys` auth trusts whatever uid a client
claims, so any host that may mount the share can read a complete copy of the
Pilke database out of this directory.

### 2. The secret

`prerequisites/secrets.unsealed.yaml` (gitignored), sealed with
`./create-secrets.bash`. The same two keys as `../garage`, and the same rule:
`rpc-secret` is **exactly** 32 bytes of hex or Garage refuses to start.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: garage-backup-secrets
  namespace: garage-backup
type: Opaque
stringData:
  rpc-secret: ""     # openssl rand -hex 32
  admin-token: ""    # openssl rand -base64 32
```

```bash
./apps/garage-backup/create-secrets.bash
git add apps/garage-backup/prerequisites/secrets.sealed.yaml
rm apps/garage-backup/prerequisites/secrets.unsealed.yaml
```

### 3. Turn it on

Uncomment `garage-backup/app.yaml` and `garage-backup/prerequisites.yaml` in
`apps/kustomization.yaml`, in the same commit as the sealed secret, and push.

```bash
kubectl -n garage-backup get pods            # garage-backup-0 2/2 Running
kubectl -n garage-backup get certificate     # garage-backup-tls Ready=True
```

A pod stuck in `ContainerCreating` is the NFS mount: `kubectl -n garage-backup
describe pod garage-backup-0` names the export it could not reach. A pod that
starts and exits with a permission error on `/var/lib/garage/meta` is step 1's
`chown`.

## Bootstrap, once

⚠️ As with `../garage`, **nothing works until the layout is assigned**, and until
then every S3 call fails as if the credential were wrong.

```bash
G="kubectl -n garage-backup exec -it garage-backup-0 -c garage -- /garage"

$G status                                   # the node id
# The capacity must not exceed the share's free space on the QNAP; Garage
# spreads data by it and believes it.
$G layout assign -z qnap -c 150G <node-id>
$G layout apply --version 1

$G bucket create pilke-postgres
$G key create pilke-postgres
# Write includes delete, which retention needs.
$G bucket allow --read --write pilke-postgres --key pilke-postgres
```

`key create` prints a key id and a secret. They go into
`apps/pilke/prerequisites/backup/backup-s3.unsealed.yaml`, and from there
`apps/pilke/README.md` takes over. If the secret scrolled away:
`$G key info pilke-postgres --show-secret`.

## What this is not

- **Not offsite.** Both boxes are in the same building, so a fire, a theft or a
  lightning strike takes both copies. The audit's recommendation is an EU
  object store as a third copy; the cheapest step from here is a nightly
  `rclone sync` of this bucket to one, through an `rclone crypt` remote so the
  provider holds ciphertext.
- **Not encrypted at rest, by Garage or by barman-cloud.** Whatever protects
  these files on the QNAP's disks is the QNAP's volume encryption, and whether
  that volume was created encrypted is not recorded anywhere. Check it in
  Storage & Snapshots. The same objects cross the LAN in the clear between this
  pod and the NAS (NFSv4 `sys`). The TLS listener here covers only the other
  hop, from the database's pod to this one.

  The fix for both at once is **SSE-C**: Garage encrypts every object with a
  key the client sends, so the NFS traffic and the disks see ciphertext. Garage
  implements it, and the Barman Cloud plugin's upstream has merged
  `s3Credentials.sseCustomerKey`, but the plugin release pinned in
  `infrastructure/cnpg-barman-cloud/app.yaml` (v0.15.1) does not have it yet. When
  a release does: seal a 32-byte key, keep a copy in the password manager
  (**without it the backups are unreadable, and it must not live only in this
  cluster**), and start a fresh `destinationPath`, since a key cannot change
  under existing objects. The TLS listener already exists because the key
  travels in a request header.
- **Not immutable.** Garage has no object versioning or object lock, and the
  key that writes the backups can also delete them, because retention has to.
  Anything holding that key, or `admin-token`, can erase them. The NetworkPolicy
  in `app/network-policy.yaml` is what limits who could try.
- **Not replicated.** One node, `replication_factor = 1`, so durability is the
  QNAP's RAID. The TS-469 Pro is a 2012 model, so check whether its firmware
  still receives security updates; either way, keep its admin interface off the
  internet and its NFS host list tight.
