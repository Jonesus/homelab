# `*.internal` for LAN-only service hostnames

This document describes how the `<svc>.internal` setup works and the one-time
manual steps needed to activate it.

`.internal` is reserved by ICANN (July 2024) for private internal use, in the
same spirit as `home.arpa` but easier to type. It will never resolve on the
public DNS, so requests can never leak.

## Architecture

```
LAN client (laptop, phone)
   │
   │ DNS query "calibre.internal"
   ▼
AdGuard Home @ 192.168.1.209  (DHCP-advertised primary resolver)
   │  wildcard rewrite *.internal → 192.168.1.208
   ▼
ingress-nginx LoadBalancer @ 192.168.1.208
   │  routes by Host header
   ▼
Service in cluster
```

DNS resolution: AdGuard runs in the cluster on a pinned MetalLB IP
(`192.168.1.209`). MikroTik DHCP advertises that IP as the primary resolver
and the router (`192.168.1.1`) as a fallback so a cluster outage does not kill
LAN DNS. The router also carries a mirror of the `*.internal` wildcard (see
`homenet/mikrotik/dns.tf`) so that clients which sticky-switch to the fallback
resolver — systemd-resolved does this readily — still get answers for
`.internal` hostnames instead of NXDOMAIN.

TLS: each `.internal` Ingress sets `nginx.ingress.kubernetes.io/ssl-redirect:
"false"` so plain HTTP works without a redirect. HTTPS is also served — every
Ingress carries a cert from the in-cluster self-signed `internal-ca`
ClusterIssuer. Browsers will show a "Not Secure" warning on HTTPS until the
root cert is trusted on each device (see *Trusting the CA* below). Public
services keep their existing Let's Encrypt certs on `*.boiss.it` unchanged.

## Manual setup steps (one-time)

### 1. Apply Kubernetes changes

```bash
# Either let ArgoCD sync, or apply manually:
kubectl apply -k public/infrastructure/cert-manager/resources
kubectl apply -k public/infrastructure/adguard
kubectl apply -k public/apps/internal-ingresses
# plus the per-app kustomizations that gained ingress-internal.yaml
```

### 2. Add the `*.internal` wildcard rewrite in AdGuard

> The router carries the same wildcard via `homenet/mikrotik/dns.tf` (applied
> in step 3 below), so the mapping ends up in two places. Keep them in sync
> if the ingress LB IP ever moves.

AdGuard's config is stored on a PVC and managed via the admin UI, so this is
not in code:

1. Open <https://adguard.boiss.it> → **Filters** → **DNS rewrites**.
2. Add a new rewrite:
   - Domain: `*.internal`
   - Answer: `192.168.1.208`  (the ingress-nginx LoadBalancer IP)
3. Save.

Test from any client already using AdGuard for DNS:

```bash
dig calibre.internal @192.168.1.209
# ;; ANSWER SECTION:
# calibre.internal.   ...   IN  A  192.168.1.208
```

### 3. Apply MikroTik DHCP changes

```bash
cd homenet/mikrotik
tofu apply
```

Existing leases keep their old DNS (`192.168.1.1` only) until renewed.
Either wait out the 1‑day lease, run `ipconfig /renew` (Windows) /
`sudo dhclient -r && sudo dhclient` (Linux) / toggle Wi‑Fi (macOS, iOS,
Android), or reboot the device. Confirm with:

```bash
# On a LAN client:
scutil --dns | grep nameserver  # macOS
resolvectl status                # Linux (systemd-resolved)
```

You should see `192.168.1.209` first.

### 4. Trust the internal CA root (per device)

Without this, browsers will show a "Not Secure" warning on `*.internal`.
The certs themselves are valid — they're just signed by a CA your device
doesn't know yet.

Export the root cert:

```bash
kubectl -n cert-manager get secret internal-ca-tls \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > internal-ca.crt
```

Install on each device:

| Device | How |
|---|---|
| **macOS** | Double-click `internal-ca.crt` → Keychain Access → System keychain → set to "Always Trust" |
| **iOS** | AirDrop the file → Settings → General → VPN & Device Management → install profile → Settings → General → About → Certificate Trust Settings → enable for the new root |
| **Linux** | `sudo cp internal-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` |
| **Windows** | Double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities |
| **Firefox** | Has its own trust store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import |
| **Android** | Settings → Security → Encryption & credentials → Install a certificate → CA certificate |

You can also skip this step and accept the browser warning per‑service.

## Adding a new service

For a new kustomize-managed app, drop an `ingress-internal.yaml` next to the
existing `ingress.yaml` and reference it from `kustomization.yaml`. Pattern:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: <svc>-ingress-internal
  namespace: <ns>
  annotations:
    cert-manager.io/cluster-issuer: "internal-ca"
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: nginx
  tls:
    - secretName: <svc>-internal-tls
      hosts:
        - <svc>.internal
  rules:
    - host: <svc>.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: <svc>
                port:
                  name: http
```

For Helm-managed apps (where the chart owns the primary Ingress), add the
`.internal` Ingress under [public/apps/internal-ingresses/](../apps/internal-ingresses/)
instead and list it in that directory's `kustomization.yaml`.

DNS resolves automatically via the `*.internal` wildcard rewrite — no per-service
DNS work required.

## Hostname registry

| Service | Public | Internal |
|---|---|---|
| AdGuard | `adguard.boiss.it` | `adguard.internal` |
| ArgoCD | `argo.home` | `argo.internal` |
| Calibre | `calibre.boiss.it` | `calibre.internal` |
| Holvi proxy | `holvi.boiss.it` | `holvi.internal` |
| Home Assistant | `hassio.boiss.it`, `hass.home` | `hass.internal` |
| Immich | `immich.boiss.it`, `kuvat.palosuo.fi` | `immich.internal` |
| Miniflux | `rss.boiss.it` | `rss.internal` |
| Paperless | `paperless.boiss.it` | `paperless.internal` |
| Taulu | `taulu.boiss.it` | `taulu.internal` |
| Vaultwarden | `vault.boiss.it` | `vault.internal` |

The legacy `argo.home` / `hass.home` hostnames still resolve via the existing
Ingresses and can be removed once `.internal` is verified working.
