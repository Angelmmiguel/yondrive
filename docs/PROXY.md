# Reverse proxies

The container speaks plain HTTP, and HTTPS normally comes from a proxy. These are the settings
that matter, then how to apply them in Nginx Proxy Manager and Traefik.

## What YonDrive needs from a proxy

| Setting | Value | Why |
| --- | --- | --- |
| Body size | At least 17 MiB | Uploads go in frames of 4 MiB, and the server accepts up to 16 MiB plus overhead. A small limit fails uploads with 413. |
| Read and send timeouts | At least 5 minutes | One frame may take up to 5 minutes on a slow link. Downloads have no time limit on the server, as they can be long. |
| Request and response buffering | Off | A buffering proxy holds frames on its disk first, and makes streaming and seeking in video slower. |
| Forwarded headers | `X-Forwarded-For`, `X-Forwarded-Proto` | So that YonDrive sees the visitor's address and that the connection is HTTPS. |
| Paths | All of the host | The app, `/api/` and `/auth/oidc/callback` are all served by YonDrive. Do not route `/api` alone. |

There are no WebSockets.

## YONDRIVE_TRUSTED_PROXIES

YonDrive ignores forwarded headers unless the connection comes from an address in
`YONDRIVE_TRUSTED_PROXIES`, as anyone could otherwise send them. Set it to the proxy's address as
YonDrive sees it, or to a range. Behind Docker, that is usually an address on the shared Docker
network, such as `172.18.0.0/16`, which `docker network inspect` shows.

If it is wrong:

- Rate limits count every visitor as the proxy, so one person's failed sign-ins can lock out everyone.
- The audit trail shows the proxy's address.
- With `YONDRIVE_SECURE=auto`, cookies are not marked `Secure`, and HSTS is not sent.

The admin area warns when requests carry forwarded headers from an address it does not trust
(`proxy_untrusted` in the settings). Only the last `X-Forwarded-For` entry is believed, the one
your proxy appended, so it must be the proxy next to YonDrive that appends it. With two proxies in
a row, trust the one next to YonDrive and have it pass on the real address.

Set `YONDRIVE_PUBLIC_URL`, or the public URL in the wizard, to the address people use, with
`https://`. Share links and the single sign-on redirect URI come from it, never from a request's
`Host`.

## Nginx Proxy Manager

1. **Hosts → Proxy Hosts → Add Proxy Host.** Domain: `drive.example.com`. Scheme `http`, the Unraid
   host's address or the container's name, and port `8990` from outside the Docker network, or
   `8080` from within it.
2. **SSL.** Request a certificate, and turn on *Force SSL* and *HTTP/2 Support*.
3. **Advanced → Custom Nginx Configuration:**

   ```nginx
   client_max_body_size 32m;
   proxy_request_buffering off;
   proxy_buffering off;
   proxy_read_timeout 600s;
   proxy_send_timeout 600s;
   ```

Nginx Proxy Manager already sets `X-Forwarded-For` and `X-Forwarded-Proto`. Set
`YONDRIVE_TRUSTED_PROXIES` to its address or to the Docker network's range.

## Traefik

Traefik has no body limit by default and does not buffer unless you add the middleware, so leave
out the `buffering` middleware. Newer versions read a request for at most a minute by default, which
is too little for a frame on a slow link, so raise it on the entry point:

```yaml
# traefik.yml
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 600s
```

Labels on the container:

```yaml
services:
  yondrive:
    image: ghcr.io/angelmmiguel/yondrive:latest
    environment:
      YONDRIVE_PUBLIC_URL: https://drive.example.com
      YONDRIVE_TRUSTED_PROXIES: 172.18.0.0/16
    volumes:
      - ./data:/data
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.http.routers.yondrive.rule=Host(`drive.example.com`)
      - traefik.http.routers.yondrive.entrypoints=websecure
      - traefik.http.routers.yondrive.tls.certresolver=letsencrypt
      - traefik.http.services.yondrive.loadbalancer.server.port=8080
```

Traefik sets `X-Forwarded-For` and `X-Forwarded-Proto`. If something else stands in front of Traefik,
list it in Traefik's own `forwardedHeaders.trustedIPs`, or Traefik overwrites what it reports.

## Checking

Sign in as an admin, and read the health and settings pages. There should be no warning about an
untrusted proxy, and the audit trail (`GET /api/v1/admin/audit`) should show your address and not the
proxy's. Then upload a file larger than 20 MiB. A 413 points at the body size, and a stall at the
timeouts.
