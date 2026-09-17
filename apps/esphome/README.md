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

To learn a code, open the device logs in the dashboard and press a button on
the original remote. The dumpers print what they recognised; `raw` is the
fallback that always works, since its microsecond timings replay through
`send_raw` whatever the protocol. If a press arrives split into several
fragments, `idle:` is shorter than the gaps between that protocol's bursts —
raise it rather than trying to stitch the pieces together.

Expect several dumpers to fire on one press: NEC, JVC and LG share enough
timing that all three latch onto the same burst. Prefer the most specific
decode, and confirm it against the Pronto header (`015B 00AF` is NEC's
9ms/4.5ms preamble).

Already mapped, from an LED candle remote (NEC, address `0xFF00`):

| Button | Command |
| --- | --- |
| On | `0xFF00` |
| Off | `0xFD02` |
| Brighter | `0xED12` |
| Dimmer | `0xEF10` |

Those are exposed as four `button` entities. There is deliberately no light
entity with a brightness level: the remote only sends relative steps and the
candles report nothing back, so any level HA displayed would be a guess that
desyncs the moment someone picks up the physical remote.

**Pin map — worked out on the hardware, because the published sources are
wrong.** The map that holds for this unit is:

| Function | Pin |
| --- | --- |
| IR receive | P8 |
| IR transmit | P7 |
| Status / WiFi LED | P26 |
| Button | P6 |

[devices.esphome.io][dev] claims receive P7 / transmit P26 / LED P8, and the
cloudcutter profile's stock-firmware `device_configuration` claims `infrr=24` /
`infre=26` / `wfst_pin=7`. Neither receives anything, and transmitting on P26
silently emits nothing — the action fires and logs "Sending remote code" while
no photons leave the case, which is a deeply unhelpful failure mode.

A throwaway diagnostic build listening on eleven candidate GPIOs at once (each
an entry under `remote_receiver` with its own `id`, a small `buffer_size`, and
an `on_raw` action logging its pin) found receive on **P8** and nowhere else,
in one flash rather than one guess per OTA. That vindicated a third community
mapping — P7 transmit, P8 receive, P24/P26 WiFi LED — whose transmit claim then
proved correct too. Build that diagnostic again if another revision turns up.

Note the trap: transmitting on the wrong pin looks like success in the logs.
The device's own receiver does not hear its own transmissions either, so the
only real confirmation is the target device responding.

That diagnostic is worth rebuilding if another board revision turns up: a list
of `remote_receiver` entries, each with a distinct `id`, a small `buffer_size`,
and an `on_raw` action logging its pin number, finds the answer in one flash
instead of one guess per OTA.

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
