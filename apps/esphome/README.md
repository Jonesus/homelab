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
cannot run in the cluster: it needs a spare WiFi adapter in AP mode on a real
(non-virtualised) NetworkManager host. Build the firmware here, pull the UF2 out
of the pod, then run [tuya-cloudcutter][cc] from a laptop on ethernet:

```sh
POD=$(kubectl -n homeassistant get pod -l app=esphome -o jsonpath='{.items[0].metadata.name}')
kubectl -n homeassistant exec "$POD" -- esphome compile /config/ir-blaster-livingroom.yaml
kubectl -n homeassistant cp \
  "$POD:/config/.esphome/build/ir-blaster-livingroom/.pioenvs/ir-blaster-livingroom/firmware.uf2" \
  ~/code/tuya-cloudcutter/custom-firmware/ir-blaster-livingroom.uf2

cd ~/code/tuya-cloudcutter
sudo ./tuya-cloudcutter.sh \
  -p tuya-generic-universal-ir-remote-control-cb3s-v2.0.0 \
  -f ir-blaster-livingroom.uf2 \
  -w <wifi-interface>
```

The script power-cycles nothing itself — it prompts, and you toggle the device
off and on 6 times (about a second apart) at two separate points to get it into
AP mode. Slow blinking means it is there; fast blinking means repeat.

Host caveats, all of which the script prompts about: it wants UDP 53, which
`systemd-resolved` holds, and it disables `ufw` for the duration (re-enable with
`sudo ufw enable`). If the exploit stalls where `hostapd` should come up,
AppArmor is the usual culprit — answer yes to stopping it and reboot afterwards
to get it back.

Two upstream bugs need local patches to the cloudcutter clone's `Dockerfile`
(both are commented in place there): Debian 11 has left LTS, so apt has to be
pointed at `archive.debian.org`, and `Pipfile.lock` pins an `ltchiptool` that
requires Python 3.10+ while the base image is 3.9 — without pinning it back to
4.13.0 the UF2 is silently rejected as invalid for the chip.

If the exploit itself fails, the device's firmware is probably not v2.0.0 any
more. Run the script with no `-p` and pick "By firmware version and name"; the
version is in the Smart Life app under the device's edit pencil → Device Update
→ Main Module. A device patched against the exploit can only be flashed by
opening the case and going at the CB3S over serial with `ltchiptool`, which is
also the only way back if both WiFi and the fallback AP are unreachable.

[cc]: https://github.com/tuya-cloudcutter/tuya-cloudcutter
[dev]: https://devices.esphome.io/devices/tuya-generic-wifi-ir-remote-control/
