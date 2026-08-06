# Serving Mobius4 over HTTPS

Mobius4 speaks the oneM2M HTTP binding over plain HTTP by default. This document is
how to put TLS in front of it: what the listener needs, how to obtain a certificate
for each of the three situations that come up, and how to replace one before it
expires.

It covers **server authentication** — clients verify that they reached this CSE, and
the traffic is encrypted. Mobius4 does not authenticate clients by certificate; see
[What TLS here does and does not prove](#what-tls-here-does-and-does-not-prove).

> **Upgrading from 4.6.x or earlier?** The listener used to be mandatory and used to
> ask clients for certificates. Both changed in 4.7.0 — read
> [What changed in 4.7.0](#what-changed-in-470) first.

---

## Quick start

Mobius4 needs two files: a private key and the certificate issued for it.

```jsonc
// config/local.json
{
  "https": {
    "enabled": true,
    "port": 7580,
    "key":  "certs/server.key",
    "cert": "certs/server.crt",
    "chain": ""            // intermediate CA bundle, when your issuer gives you one
  }
}
```

Paths are resolved relative to the process working directory — the repository root
under `npm start`, `/app` in the container image. Absolute paths work too and are
clearer when the files live outside the deployment, which is usual for certificates
managed by something else.

Then restart. The startup log says which way it went:

```
HTTPS server listening                       {"port":7580}
HTTPS is disabled (https.enabled is false); serving HTTP only
```

If `https.enabled` is true and a file cannot be read, Mobius4 **stops** rather than
falling back to plain HTTP, and names the setting that pointed at it:

```
FATAL  https.enabled is true but the private key at "certs/server.key" could not be
       read. Point https.key at a readable file or set https.enabled to false.
```

A silent downgrade would be worse: nothing on the client side distinguishes "the
operator turned TLS off" from "the certificate went missing this morning".

---

## Configuration keys

| Key | Meaning |
| :--- | :--- |
| `https.enabled` | Whether to start the TLS listener at all. Default `false` |
| `https.port` | Port for the TLS listener. Default `7580` |
| `https.key` | PEM private key for the server certificate |
| `https.cert` | PEM server certificate |
| `https.chain` | PEM bundle of intermediate CA certificates. Leave `""` when the issuer is a root your clients already trust, or when the certificate is self-signed |

`http.port` is unaffected: the plain listener keeps running. Closing it is a matter
for the firewall or the reverse proxy in front, not a Mobius4 setting.

---

## Getting a certificate

Three situations, in the order most deployments meet them.

### 1. A public hostname — use a public CA

If the CSE answers on a name resolvable from the internet, a publicly trusted
certificate means clients need no configuration at all. [Let's Encrypt](https://letsencrypt.org)
issues them at no cost:

```bash
sudo certbot certonly --standalone -d cse.example.org
```

That writes, under `/etc/letsencrypt/live/cse.example.org/`:

| File | Points at |
| :--- | :--- |
| `privkey.pem` | `https.key` |
| `cert.pem` | `https.cert` |
| `chain.pem` | `https.chain` |
| `fullchain.pem` | `cert.pem` and `chain.pem` concatenated — use it for `https.cert` and leave `https.chain` empty, if you prefer one file |

Certbot renews on a timer, and the files keep their paths, but **Mobius4 reads them
once at startup**. A renewal does not reach the running process. Add a restart to the
renewal hook:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/restart-mobius4.sh
#!/bin/sh
pm2 restart mobius4        # or: docker compose restart mobius4
```

The Mobius4 process runs as an unprivileged user and `/etc/letsencrypt/live` is
root-only, so either copy the two files somewhere it can read after each renewal, or
grant that user read access to the key. Copying is easier to reason about.

### 2. An internal deployment — use your organisation's CA

Where the CSE is reachable only inside a network, the certificate normally comes from
whoever runs the internal PKI. You give them a CSR and they return a certificate:

```bash
# Private key — keep it on the server, never send it anywhere
openssl genrsa -out certs/server.key 2048
chmod 600 certs/server.key

# Certificate signing request
openssl req -new -key certs/server.key -out certs/server.csr \
  -subj "/CN=cse.internal.example/O=Your Organisation"
```

Send `server.csr`. Put what comes back at `https.cert`, and the issuing CA's
intermediate bundle at `https.chain`. Clients must trust the internal root — usually
already the case on managed machines.

**The name in the certificate must be the name clients use.** Modern clients read the
Subject Alternative Name, not the Common Name, so ask for a SAN. If clients reach the
CSE by IP address, it needs an IP SAN — many internal CAs refuse those, which is one
reason to give the CSE a DNS name.

### 3. Development and testing — self-signed

Fine for a laptop, and for nothing else. Clients have no way to tell such a
certificate from an attacker's, so they must be told to skip verification, and any
habit of doing that tends to survive into production.

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
chmod 600 certs/server.key
```

Verify:

```bash
curl -k https://localhost:7580/health
```

`-k` is the client skipping verification. Needing it is the signal that this
certificate is not for production.

---

## Where the files live

**`certs/` is in `.gitignore`, and the private key must never be committed.** Up to
4.6.5 this repository shipped one at `certs/wdc.key` — see
[What changed in 4.7.0](#what-changed-in-470).

- Permissions: `chmod 600` on the key, owned by the user Mobius4 runs as.
- Backups: the key belongs in the same protected place as your database credentials.
  Losing it means reissuing; leaking it means revoking.
- Containers: mount the files in, do not build them into the image. `certs` is in
  `.dockerignore` for that reason.

---

## Replacing a certificate

Certificates expire. Public CAs issue for 90 days or less; internal ones vary.

```bash
# 1. What you have now, and until when
openssl x509 -in certs/server.crt -noout -subject -enddate -ext subjectAltName

# 2. Put the new key and certificate in place (procedure above)

# 3. Check that the key and the certificate are a pair — these two must match
openssl pkey -in certs/server.key -pubout -outform der | openssl sha256
openssl x509 -in certs/server.crt -pubkey -noout | openssl pkey -pubin -pubout -outform der | openssl sha256

# 4. Restart. Mobius4 reads TLS material only at startup.
pm2 restart mobius4
```

Step 3 catches the common mistake of copying a new certificate over an old key. Left
undetected, the listener fails at startup with a key/certificate mismatch rather than
anything about certificates.

To check what is actually being served:

```bash
openssl s_client -connect cse.example.org:7580 -servername cse.example.org </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate
```

---

## What TLS here does and does not prove

**Does**: the traffic is encrypted, and a client that verifies the certificate knows
it reached this CSE and not something in between.

**Does not**: say anything about who the client is. Mobius4 does not ask clients for
certificates, and would not act on one if it did — there is no code in this source
that reads a peer certificate.

That matters because the oneM2M originator is a request header. `X-M2M-Origin` is
whatever the client writes in it, over TLS exactly as over plain HTTP, and access
control decides from that value. TLS raises no bar for an originator claiming to be
another AE, or the administrator.

What does hold that line today:

- `cse.admin` must be an identity unique to the deployment; Mobius4 refuses to start
  otherwise, and refuses the value published in earlier versions. See
  [configuration.md](configuration.md).
- `<accessControlPolicy>` resources govern everything else.

Binding a client certificate to the originator it may claim is worth doing — it is
what would make an issued certificate an authentication factor rather than a
transport detail — and is tracked as future work. Until then, treat the network path
as authenticated and the originator as asserted.

---

## What changed in 4.7.0

Two things, both of which can surprise an existing deployment.

**The listener is now optional, and off by default.** Before 4.7.0 `bindings/http.js`
read `certs/ca.crt`, `certs/wdc.key` and `certs/wdc.crt` at module load, with no
condition and no error handling, so a checkout without those three files could not
start at all. There was no setting to turn it off. Anyone upgrading who wants TLS must
now set `https.enabled: true` and point `https.key` and `https.cert` at their own
files; the old hardcoded paths are gone.

**Client certificates are no longer requested.** The listener used to set
`requestCert: true` and `rejectUnauthorized: true`, which reads as mutual TLS. Nothing
ever looked at the certificate that arrived: with no `getPeerCertificate` call in the
source, the identity proved by the handshake was never compared against the
`X-M2M-Origin` of the request. Any holder of a certificate signed by the configured CA
could act as any originator, the administrator included. The requirement was removed
rather than left in place, because an assurance that is not delivered is worse than a
missing one — deployments plan around it.

If your clients were presenting certificates, they will continue to work: the
certificate is now simply ignored. If you were relying on the CA requirement to keep
unknown clients out, that reliance was already misplaced, and the replacement is
network-level access control (firewall, reverse proxy, mTLS terminated in front) plus
oneM2M access control.

**The certificates that used to ship in this repository were deleted**, including two
private keys (`certs/wdc.key`, `certs/SAE1.key`). They remain in the git history, so
**treat both as disclosed**: any deployment still serving `wdc.crt` should issue a new
certificate by the procedure above, and any client still holding `SAE1.key` should be
reissued if it is used for anything.
