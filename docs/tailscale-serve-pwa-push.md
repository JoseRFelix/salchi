# Tailscale Serve for PWA Push Notifications

Use this setup when Salchi is running on a VPS or remote machine and you want the browser/PWA to support service workers and push notifications without exposing the app to the public internet.

## Why this is needed

Browser push notifications require a secure origin. `localhost` is treated as secure for local development, but a raw tailnet IP such as `http://100.x.y.z:3773` is not. Tailscale Serve gives the app an HTTPS `*.ts.net` URL that is still private to your tailnet.

Tailscale Serve is private. Tailscale Funnel is public. Do not use Funnel for this setup unless you intentionally want public internet access.

## One-time Tailscale setup

1. In the Tailscale admin console, enable MagicDNS.
2. In the Tailscale admin console, enable HTTPS certificates.
3. On the VPS, confirm the device has a MagicDNS name:

```bash
tailscale status
```

The final URL will look like:

```text
https://your-vps.your-tailnet.ts.net
```

## Run Salchi privately over HTTPS

Use the Tailscale Serve flag. It binds the app server to loopback by default, enables Tailscale Serve, and prints a pairing URL that uses the MagicDNS HTTPS name when it is available:

```bash
salchi serve --tailscale-serve
```

Equivalent explicit `serve` command:

```bash
salchi serve --host 127.0.0.1 --port 3773 --tailscale-serve --tailscale-serve-port 443
```

Equivalent environment variables:

```bash
SALCHI_HOST=127.0.0.1
SALCHI_PORT=3773
SALCHI_TAILSCALE_SERVE=true
SALCHI_TAILSCALE_SERVE_PORT=443
salchi serve
```

Then open the app from a tailnet device at:

```text
https://your-vps.your-tailnet.ts.net
```

Do not open the app from the raw tailnet IP if you want push notifications:

```text
http://100.x.y.z:3773
```

## Security checklist

- Keep the Salchi server bound to `127.0.0.1`.
- Do not open port `3773` in the VPS firewall or cloud security group.
- Use `tailscale serve`, not `tailscale funnel`.
- Confirm only intended users/devices can reach the machine through Tailscale ACLs.

## Enable notifications in the PWA

1. Open Salchi at the HTTPS `*.ts.net` URL.
2. Go to `Settings -> General`.
3. Enable `Push notifications`.
4. Use `Test` to confirm delivery.

On iOS and iPadOS, install the site to the Home Screen first, then enable notifications from the installed PWA.

## Operational notes

- The server stores VAPID keys in the Salchi secrets directory so browser subscriptions survive restarts.
- Browser subscriptions are tied to authenticated sessions. Revoked or expired sessions are skipped when notifications are sent.
- If a browser push endpoint expires or is rejected by the upstream push service, the server disables that subscription.
- Notification delivery uses the browser vendor push service, so the VPS needs outbound internet access.
