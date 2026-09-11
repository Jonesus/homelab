# ESPHome

ESPHome Device Builder (the web dashboard) at https://esphome.internal — it
compiles firmware and pushes OTA updates to ESPHome devices on the LAN.

Device YAMLs live in [`config/`](config/) and are mounted into the pod from a
kustomize-generated ConfigMap, so **git is the source of truth**: editing a file
here changes the ConfigMap hash, which rolls the Deployment and makes the
dashboard pick the new config up. Those files are read-only inside the web UI by
design — don't try to edit them there.

`secrets.yaml` comes from the `esphome-secrets` SealedSecret and holds the WiFi
credentials plus a per-device API encryption key and OTA password.

## Storage

The PVC is 15Gi because it holds the PlatformIO toolchains and per-device build
trees. The LibreTiny (Beken BK72xx) toolchain alone unpacks to a couple of GB.
Deployment strategy is `Recreate` — the PVC is ReadWriteOnce, so never two pods.

The dashboard's normal device discovery is mDNS, which does not cross the pod
network boundary, so `ESPHOME_DASHBOARD_USE_PING=true` makes it ping instead.
For the same reason Home Assistant will not auto-discover these devices: add
them in the ESPHome integration by IP and paste the API encryption key.

## Devices

### `ir-blaster-livingroom`

Tuya generic WiFi IR remote control, CB3S module (Beken BK7231N). Stock Tuya
firmware was removed with [tuya-cloudcutter][cc] using profile
`tuya-generic-universal-ir-remote-control-cb3s-v2.0.0` — the device no longer
talks to Tuya's cloud and the Smart Life app can no longer control it.

Two API actions are exposed to Home Assistant:

- `esphome.ir_blaster_livingroom_send_raw` — takes `code`, a list of
  microsecond durations (positive = mark, negative = space), exactly the format
  `remote_receiver` prints to the logs.
- `esphome.ir_blaster_livingroom_send_pronto` — takes `data`, a Pronto hex
  string, the format most online IR code databases use.

To learn a code, open the device logs in the dashboard and press a button on the
original remote; `dump: all` prints what it decoded. Once you have collected
everything you need, set `dump: []` to quiet the logs down.

**Pin map caveat:** revisions of this "generic" hardware disagree on pinout.
The config follows [devices.esphome.io][dev] (IR receive P7, status LED P8),
while the cloudcutter profile for the same device reports IR receive on P24 and
the status LED on P7. IR transmit P26 and button P6 are consistent everywhere.
If transmitting works but received codes never appear in the logs, swap those
two pins and push an OTA update — no reflash, no opening the case.

## Reflashing from scratch

Only needed if the device is bricked or the fallback AP is gone. Cloudcutter
needs a spare WiFi adapter and has to run on a real (non-virtualised) host with
NetworkManager, not in the cluster — see [tuya-cloudcutter][cc]. Recovering a
device whose WiFi and fallback AP are both unreachable means opening the case
and flashing the CB3S over serial with `ltchiptool`.

[cc]: https://github.com/tuya-cloudcutter/tuya-cloudcutter
[dev]: https://devices.esphome.io/devices/tuya-generic-wifi-ir-remote-control/
