---
title: Self-hosting Track Your Time
sidebar_label: Self-hosting
description: Install Track Your Time on your own Ubuntu server with Docker Compose, check the install with one script, and back it up, upgrade it and fix it.
---

<!-- Generated from docs/self-hosting.md by scripts/docs/sync-self-hosting.mjs. Do not edit by hand: edit the source, then run `pnpm docs:sync`. -->

# Self-hosting Track Your Time

Run your own instance of Track Your Time on your own server, with your own
database. You need one Ubuntu server, one domain and one `docker compose`
command.

This guide is written so that a person or an AI assistant can follow it on a
fresh Ubuntu VPS. Every install step has three parts. **Run** gives the exact
command. **Expect** says what success looks like. **If it fails** lists the
usual causes and their fixes.

This is not the maintainer's own deployment. That one is a two-domain split on
Coolify, documented in [`deploy.md`](https://github.com/trebeljahr/tracktime/blob/main/docs/deploy.md). Nothing here interacts with
it.

**One limit to know before you start.** No release has been published yet:
`git tag` in the repository prints nothing. There are no version-tagged images
to pull, so the first start builds both images from source on your server.
That build needs about 4 GB of memory. A smaller server works if you add swap
([Step 0.4](#step-04-add-swap-if-the-server-has-less-than-4-gb-of-ram)).

## Contents

- [Install with an AI assistant](#install-with-an-ai-assistant)
- [What you get, and what it costs to run](#what-you-get-and-what-it-costs-to-run)
- [Before you start](#before-you-start)
- [Install](#install)
  - [Step 0. Prepare a fresh Ubuntu server](#step-0-prepare-a-fresh-ubuntu-server)
  - [Step 1. Point your domain at the server](#step-1-point-your-domain-at-the-server)
  - [Step 2. Get the files](#step-2-get-the-files)
  - [Step 3. Create your `.env`](#step-3-create-your-env)
  - [Step 4. Generate the session secret](#step-4-generate-the-session-secret)
  - [Step 5. Set your domain](#step-5-set-your-domain)
  - [Step 6. Start the stack](#step-6-start-the-stack)
  - [Step 7. Wait for the services to become healthy](#step-7-wait-for-the-services-to-become-healthy)
  - [Step 8. Verify the install](#step-8-verify-the-install)
  - [Step 9. Create your account](#step-9-create-your-account)
  - [Where the images come from](#where-the-images-come-from)
- [Accounts, and what "admin" means here](#accounts-and-what-admin-means-here)
- [Email](#email)
- [Why one domain, and what it would take to split](#why-one-domain-and-what-it-would-take-to-split)
- [Backup and restore](#backup-and-restore)
- [Upgrading](#upgrading)
- [Optional integrations](#optional-integrations)
- [The other clients](#the-other-clients)
- [Troubleshooting](#troubleshooting)
- [Reference: the files involved](#reference-the-files-involved)

---

## Install with an AI assistant

An assistant with shell access to your server can do the whole install. Copy
this prompt and replace `<domain>` with your domain:

```text
Set up Track Your Time on my Ubuntu server at <domain>, following https://github.com/trebeljahr/tracktime/blob/main/docs/self-hosting.md. Run scripts/selfhost-check.sh <domain> at the end and show me its output.
```

Before you send it, make sure the assistant has these:

| It needs | Why |
|---|---|
| SSH access to the server, as root or as a user with `sudo` | It installs Docker, clones the repository and starts the containers. |
| A DNS `A` record for the domain that already points at the server | Certificate issuance fails until the record resolves. Add an `AAAA` record too if the server has IPv6. |
| Ports 80 and 443 open in your cloud provider's firewall | The assistant can open the server's own firewall. It usually cannot reach the provider's control panel. |
| SMTP credentials, optionally | Only for password-reset mail. The app works without them. See [Email](#email). |

The assistant does **not** need an account with any service. There is no
registry login, no API key, no licence key and no sign-up with a third party.
Everything it downloads comes from public URLs: the Docker install script, the
GitHub repository and the public base images.

**Keep your secrets out of the chat.** `BETTER_AUTH_SECRET` and the whole
`.env` file stay on the server. Step 4 writes the secret straight into `.env`
without printing it. Do not paste `.env` into a conversation, and do not ask an
assistant to show it. If you use SMTP, type the password into `.env` yourself
over SSH and tell the assistant that it is there.

---

## What you get, and what it costs to run

One domain and five containers, all on your server:

| Container | Image | Does |
|---|---|---|
| `caddy` | `caddy:2.11-alpine` | TLS. The only container with published ports. Sends `/api/*` and `/ws` to the server, and everything else to the web app. |
| `server` | `ghcr.io/trebeljahr/tracktime-server` | The API (tRPC and REST), authentication and the live-sync WebSocket. |
| `client` | `ghcr.io/trebeljahr/tracktime-client-selfhost` | The web app: a static export served by a second, small Caddy. |
| `mongo` | `mongo:7.0` | All of your data, including accounts and sessions. |
| `redis` | `redis:7.4-alpine` | Present but unused. See [Optional integrations](#optional-integrations). |

The whole feature set works with nothing else configured. That covers time
tracking, the client, project and task catalog, tags, reports, invoices, CSV
and JSON import and export, and the browser and Raycast clients. No account
with any service is required. The self-host client image is built without the
analytics variables, so the web app loads no third-party script. A self-hosted
instance makes no request from the browser that you did not ask for.

**Running cost.** One small VPS and one domain name. Certificates come from
Let's Encrypt at no cost. The figures below are guidance, not benchmarks:

| | Guidance |
|---|---|
| RAM, building the images on the server (needed today) | 4 GB, or less RAM plus a swapfile. `next build` for the web app uses the most memory, and the kernel kills it on a 1 GB server with no swap. |
| RAM, running the stack | 1 GB works for a single user. 2 GB is comfortable. MongoDB uses the most. |
| RAM, pulling published images (once a release exists) | Same as running the stack. |
| Disk | 5 GB for images and volumes, plus your data. Time entries are small. A heavy year of tracking takes megabytes. A local build needs several GB more for the build cache, which `docker builder prune` frees afterwards. |
| CPU | 1 vCPU is enough to run it. The first build is slow on 1 vCPU. PDF and CSV generation is the only bursty work at runtime. |

**What it does not do.** There is no clustering and no horizontal scaling. The
server must run as exactly one replica, because live sync fans out inside the
process. A second replica would not show an error. It would deliver live
updates only to the devices that connected to the same process. The compose
file runs one replica. Keep it that way.

---

## Before you start

| Requirement | Notes |
|---|---|
| A server with a public IP | Any VPS running Ubuntu 22.04 or 24.04. Other Linux distributions work if you install Docker yourself. |
| Docker Engine with the Compose v2 plugin | [Step 0.1](#step-01-install-docker-engine-and-the-compose-plugin) installs both. The old Python `docker-compose` 1.x does not work: the compose file uses `depends_on` health conditions and `${VAR:?...}` substitution. |
| A domain, with an `A` record pointing at the server | Also an `AAAA` record if the server has IPv6. The record must resolve **before** you start the stack, or certificate issuance fails. |
| Ports 80 and 443 reachable from the internet | Port 80 is not optional: the ACME HTTP challenge uses it. 443/udp is also published, for HTTP/3. |
| Root, or a user with `sudo` | |
| About 4 GB of memory for the first build | RAM plus swap. See the limit at the top of this guide. |

**ARM servers.** The release workflow builds `linux/amd64` and `linux/arm64`
images. Until a release exists, the local build also runs natively on ARM,
because every base image is multi-arch. MongoDB 7.0 on ARM needs an ARMv8.2-A
CPU or newer. An Ampere VPS, a Raspberry Pi 5 and an Apple-silicon machine
qualify. A Raspberry Pi 4 or older does not.

---

## Install

Replace `track.example.com` with your domain in every command. Steps 2 to 9
run from the directory that holds `docker-compose.selfhost.yml`.

### Step 0. Prepare a fresh Ubuntu server

Skip any part of this step that is already done on your server.

#### Step 0.1. Install Docker Engine and the Compose plugin

This uses Docker's official convenience script from `get.docker.com`. It adds
Docker's apt repository and installs Docker Engine, the CLI, containerd, and
the Buildx and Compose plugins. It needs `sudo`. If you prefer to add the apt
repository by hand, follow Docker's
[Ubuntu install guide](https://docs.docker.com/engine/install/ubuntu/) instead.

**Run**

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
```

```bash
sudo sh get-docker.sh
```

**Expect** the script to end without an error. Then check both parts:

```bash
sudo docker --version
```

This prints `Docker version` followed by a version number, for example
`Docker version 28.x.y, build …`.

```bash
sudo docker compose version
```

This prints `Docker Compose version v2.x.y` or a newer version.

**Run** this if you work as a user other than root, so that `docker` works
without `sudo`:

```bash
sudo usermod -aG docker $USER
```

Log out and log in again (for an assistant: open a new SSH session). Membership
in the `docker` group gives root-equivalent access to the server, so add only
users you trust.

**Expect** `docker ps` to print a table header (`CONTAINER ID   IMAGE …`) with
no `sudo`.

**If it fails**

| Symptom | Fix |
|---|---|
| `sudo: command not found`, or you are not in `sudoers` | Log in as root, or ask your provider for a sudo user. |
| `docker: 'compose' is not a docker command` | The Compose plugin is missing. Run `sudo apt-get install -y docker-compose-plugin`. |
| `permission denied while trying to connect to the Docker daemon socket` | Your user is not in the `docker` group yet, or you did not log in again. Log out and in, or prefix Docker commands with `sudo`. |
| `Cannot connect to the Docker daemon` | The service is not running. Run `sudo systemctl enable --now docker`. |

#### Step 0.2. Open ports 80 and 443

There are two firewalls to think about: the one on the server (`ufw` on
Ubuntu) and the one at your cloud provider.

**Run**

```bash
sudo ufw status
```

**Expect** one of two answers:

- `Status: inactive`. The server's firewall blocks nothing. Go on to the cloud
  provider's firewall below.
- `Status: active`. Allow the web ports with the two commands below.

```bash
sudo ufw allow 80,443/tcp
```

```bash
sudo ufw allow 443/udp
```

Then `sudo ufw status` lists `80,443/tcp` and `443/udp` with `ALLOW`.

Do not enable `ufw` on a server where it is inactive unless you allow SSH
first (`sudo ufw allow OpenSSH`). Otherwise you lock yourself out.

Docker writes its own iptables rules for published ports, and those rules
bypass `ufw`. A `ufw` rule therefore rarely blocks this stack. The cloud
provider's firewall is the usual cause.

**Cloud provider firewall.** Most VPS providers filter traffic before it
reaches the server, in a panel called a firewall, a security group or a network
policy. Allow inbound TCP 80, TCP 443 and UDP 443 from anywhere. The server
cannot check this rule from the inside. [Step 8](#step-8-verify-the-install)
checks it from the outside once the stack runs.

**If it fails**

| Symptom | Fix |
|---|---|
| `ufw: command not found` | Nothing to open on the server. Check the cloud provider's firewall. |
| Later, `selfhost-check.sh` reports `port 80 … does not answer` or a timeout | The cloud provider's firewall still blocks the port. Open it there. |

#### Step 0.3. Install git

**Run**

```bash
git --version
```

**Expect** `git version 2.x.y`.

**If it fails** with `git: command not found`, install it:

```bash
sudo apt-get update
```

```bash
sudo apt-get install -y git
```

#### Step 0.4. Add swap if the server has less than 4 GB of RAM

The first start builds the images on the server, and the web-app build needs
about 4 GB of memory. RAM plus swap counts.

**Run**

```bash
free -h
```

**Expect** a `Mem:` row and a `Swap:` row. If `Mem:` total is 4 GB or more
(shown as about `3.8Gi`), or `Swap:` already shows 4 GB, skip the rest of this
step.

Otherwise, add a 4 GB swapfile. Run these five commands in order:

```bash
sudo fallocate -l 4G /swapfile
```

```bash
sudo chmod 600 /swapfile
```

```bash
sudo mkswap /swapfile
```

```bash
sudo swapon /swapfile
```

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Expect** `swapon --show` to print a line that starts with
`/swapfile file 4G`. The last command keeps the swapfile after a reboot.

**If it fails**

| Symptom | Fix |
|---|---|
| `fallocate failed: Operation not supported` | Create the file with `sudo dd if=/dev/zero of=/swapfile bs=1M count=4096` instead, then continue with `chmod`. |
| `swapon: /swapfile: swapon failed: Device or resource busy` | The swapfile is already active. Nothing to do. |
| `fallocate: fallocate failed: No space left on device` | The disk has less than 4 GB free. Free space, or resize the disk. |

### Step 1. Point your domain at the server

Do this early. DNS changes can take minutes to reach every resolver, and you
can continue with Steps 2 to 5 while you wait.

**Run** this on the server to find its public IPv4 address:

```bash
curl -4 -s https://ifconfig.me
```

**Expect** one IPv4 address, for example `203.0.113.10`. Your provider's
control panel shows the same address.

At your DNS provider, create an `A` record for `track.example.com` with that
address. If the server has a public IPv6 address (`curl -6 -s https://ifconfig.me`
prints one), also create an `AAAA` record with it. If it has none, create no
`AAAA` record.

**Run** this to check the record:

```bash
dig +short track.example.com A
```

**Expect** exactly the address from `ifconfig.me`. If the domain has an `AAAA`
record, `dig +short track.example.com AAAA` prints the server's IPv6 address.

**If it fails**

| Symptom | Fix |
|---|---|
| `dig: command not found` | Run `sudo apt-get install -y dnsutils`. |
| No output | The record does not exist yet, or has not propagated. Check the spelling at your DNS provider, wait a few minutes and run `dig` again. |
| A different address | The record points somewhere else. Correct it. If your DNS provider proxies traffic through its own network, set the record to "DNS only" so that Caddy can obtain a certificate. |
| An `AAAA` record exists but the server has no IPv6 | Delete the `AAAA` record. A wrong `AAAA` record can make certificate issuance fail and breaks the site for IPv6 visitors. |

### Step 2. Get the files

**Run**

```bash
git clone https://github.com/trebeljahr/tracktime.git
```

```bash
cd tracktime
```

**Expect** `ls docker-compose.selfhost.yml Caddyfile .env.selfhost.example` to
print the three file names with no error.

The stack reads only those three files. Clone the whole repository anyway: with
no published release, Docker builds the images from this checkout, and the
build needs the whole tree.

**If it fails**

| Symptom | Fix |
|---|---|
| `fatal: destination path 'tracktime' already exists` | A clone is already there. Run `cd tracktime` and continue. |
| `Could not resolve host: github.com` | The server has no outbound DNS or internet access. Fix the network first. |

### Step 3. Create your `.env`

**Run**

```bash
cp .env.selfhost.example .env
```

```bash
chmod 600 .env
```

**Expect** `ls -l .env` to show `-rw-------`, so only the owner can read the
file.

Compose reads `.env` from the current directory on its own, which is why the
copy has that name. To keep a different file name, pass
`--env-file .env.selfhost` on every compose command.

### Step 4. Generate the session secret

`BETTER_AUTH_SECRET` signs every session. This command generates a random
value and writes it into `.env` without printing it:

**Run**

```bash
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" .env
```

**Expect** the first check to print `1` and the second to print `0`. Neither
prints the secret.

```bash
grep -c '^BETTER_AUTH_SECRET=.\{40,\}$' .env
```

```bash
grep -c 'replace-me' .env
```

Keep this value stable. Changing it signs every device out. It cannot be
recovered, so keep a copy of `.env` somewhere private (see
[What is not in the backup](#what-is-not-in-the-backup)).

**If it fails**

| Symptom | Fix |
|---|---|
| The first check prints `0`, or the second prints `1` | The line was not replaced. Check that `.env` has a line starting with `BETTER_AUTH_SECRET=`, then run the `sed` command again. |
| `openssl: command not found` | Run `sudo apt-get install -y openssl`. |

### Step 5. Set your domain

**Run**

```bash
sed -i "s|^APP_DOMAIN=.*|APP_DOMAIN=track.example.com|" .env
```

**Expect** `grep '^APP_DOMAIN=' .env` to print `APP_DOMAIN=track.example.com`:
the bare domain, with no scheme and no path.

That is the last required value. Everything else in `.env` is optional and
commented out:

| Variable | When you need it |
|---|---|
| `APP_DOMAIN` | Always. The site address, and therefore the certificate that Caddy requests. |
| `BETTER_AUTH_SECRET` | Always. |
| `TRACKTIME_VERSION` | The image tag to pull. Bump it to upgrade once releases exist. See [Upgrading](#upgrading). |
| `APP_URL` | Only when the origin is not `https://${APP_DOMAIN}`: a plain-HTTP local trial, or a non-standard port. |
| `SMTP_*`, `EMAIL_FROM` | Only for outgoing mail. See [Email](#email). |
| `TRUST_STORE_APPS` | Only to refuse the phone apps and the store extension. It is `true` by default. See [The other clients](#the-other-clients). |
| `TRUSTED_ORIGINS` | Only for an extension you built yourself, or a web app that copies data in directly. See [The other clients](#the-other-clients). |
| `MONGODB_URI`, `REDIS_URL` | Only to use a managed database instead of the containers. |

The app must run at the **root** of the domain. Hosting it under
`https://example.com/tracktime/` breaks live sync: the browser derives the
WebSocket URL from its origin, which still resolves to `example.com/ws`.

**If it fails**

| Symptom | Fix |
|---|---|
| `grep` prints nothing | The `APP_DOMAIN=` line is missing or commented out. Add `APP_DOMAIN=track.example.com` to `.env` on its own line. |
| The value contains `https://` or a `/` | Remove them. `APP_DOMAIN` is the host name only. |

### Step 6. Start the stack

**Run**

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

**Expect** a long first run. Compose first tries to pull
`ghcr.io/trebeljahr/tracktime-server` and
`ghcr.io/trebeljahr/tracktime-client-selfhost` at the tag in
`TRACKTIME_VERSION`. No release exists yet, so both pulls fail, and Compose
builds the two images from the clone. The build takes several minutes. The web
app is the slowest part. `mongo`, `redis` and `caddy` are pulled from Docker
Hub.

The command ends with one line per container, such as
`✔ Container tracktime-server-1  Started` or `Healthy`. Its exit status is
`0`. Later starts take seconds.

To avoid typing `-f docker-compose.selfhost.yml` on every command, export it
once per shell:

```bash
export COMPOSE_FILE=docker-compose.selfhost.yml
```

The rest of this guide keeps the flag, so every block works when pasted.

**If it fails**

| Symptom | Fix |
|---|---|
| `exit code: 137`, or `Killed`, during the build | The kernel stopped the build because memory ran out. Add swap ([Step 0.4](#step-04-add-swap-if-the-server-has-less-than-4-gb-of-ram)) and run the `up -d` command again. The finished build stages are cached. |
| `required variable APP_DOMAIN is missing a value` | Compose found no `.env` with `APP_DOMAIN` in the current directory. `cd` into the clone, or repeat [Step 5](#step-5-set-your-domain). The compose file stops on purpose rather than request a certificate for an empty name. |
| `required variable BETTER_AUTH_SECRET is missing a value` | Repeat [Step 4](#step-4-generate-the-session-secret). |
| `Bind for 0.0.0.0:80 failed: port is already allocated`, or `address already in use` | Another program owns port 80 or 443, often a web server installed with the OS image. `sudo ss -tlnp` lists every listening program. Find the one on `:80` or `:443` and stop it. |
| `no space left on device` | The build cache filled the disk. Run `docker builder prune`, free space, and run `up -d` again. |
| `permission denied while trying to connect to the Docker daemon socket` | See [Step 0.1](#step-01-install-docker-engine-and-the-compose-plugin). |

### Step 7. Wait for the services to become healthy

**Run**

```bash
docker compose -f docker-compose.selfhost.yml ps
```

**Expect** five rows, for `caddy`, `client`, `mongo`, `redis` and `server`,
each with a `STATUS` of `Up … (healthy)`.

The services start in order. Mongo and Redis come first, then the server, and
Caddy last. Caddy waits for both the server and the client to be healthy.
`depends_on` enforces that order, so a slow first Mongo start delays the rest
rather than breaking it.

**If it fails**

| Symptom | Fix |
|---|---|
| `(health: starting)` | Wait one or two minutes and run `ps` again. The healthchecks run every 10 to 30 seconds. |
| `caddy` is missing from the list, or `Created` but not `Up` | Caddy is still waiting for `server` or `client`. Look at those two first. |
| `server` is `unhealthy` or `Restarting` | `docker compose -f docker-compose.selfhost.yml logs --tail 100 server`. A missing variable prints `Missing required environment variable`. If `mongo` is unhealthy too, fix Mongo first. |
| `mongo` is `unhealthy` or `Restarting` | See [MongoDB does not start](#mongodb-does-not-start). |
| A service is `Exited` | `docker compose -f docker-compose.selfhost.yml logs --tail 100 <service>` shows why. |

### Step 8. Verify the install

**Run** a quick check of the API through the proxy:

```bash
curl -sS https://track.example.com/api/health
```

**Expect** one line of JSON:

```json
{"status":"ok","db":true,"webUrl":"https://track.example.com","version":"","timestamp":"2026-09-13T12:00:00.000Z"}
```

- `status` is `ok` when the server answers.
- `db` is `true` when MongoDB is connected.
- `webUrl` is the origin the server derived from `APP_URL`. It must match what
  you type in the browser, character for character. Fix it now if it does not,
  rather than debugging sign-in later.
- `version` is the commit the image was built from. Self-host images are built
  without that value, so it is empty, and that is expected.

**Run** the full check script from the clone directory:

```bash
scripts/selfhost-check.sh track.example.com
```

It prints one `PASS`, `FAIL` or `SKIP` line per check. Each `FAIL` has a
`fix:` line under it. The script exits with status 0 when nothing fails and 1
when anything does. It checks:

| Check | Passes when |
|---|---|
| DNS | The `A` record exists. On the server, once the containers exist, it also matches the server's public IPv4 address, and an `AAAA` record, if present, matches the server's IPv6 address. |
| Containers | Every service in `docker-compose.selfhost.yml` is running and healthy. Runs where Docker is installed and the compose file is in the current directory. |
| HTTPS certificate | `curl` connects over HTTPS without `-k`, so the certificate is valid and trusted. |
| Port 80 | `http://` answers with a redirect to HTTPS. Certificate renewals need port 80. |
| `/api/health` | It returns `status` `ok`, `db` `true`, and a `webUrl` equal to `https://track.example.com` (or `APP_URL`). |
| `/` | The web app answers `200` with HTML. |
| `/api/auth/get-session` | It answers JSON, not HTML. HTML here means sign-in requests reach the web app instead of the server. |
| `/api/v1/openapi.json` | The REST API answers JSON. |
| `/ws` | A WebSocket upgrade reaches the server, which answers `401` to a request with no session. A `404`, a `502` or the web app's HTML means the socket is routed wrong. |
| API token (optional) | With `--token tt_…`, `GET /api/v1/me` accepts the token and the script lists its scopes. |

**Expect** output like this from a healthy install, run on the server:

```text
Track Your Time self-host check: https://track.example.com

PASS  DNS: track.example.com resolves to 203.0.113.10, this machine's public IPv4
SKIP  DNS AAAA (no AAAA record, the site is IPv4 only)
PASS  containers: 5/5 services running and healthy (caddy client mongo redis server)
PASS  HTTPS certificate for track.example.com is valid and trusted
PASS  port 80 answers and redirects to HTTPS (HTTP 308)
PASS  GET /api/health reports status ok
PASS  GET /api/health reports db:true (MongoDB connected)
PASS  GET /api/health webUrl is https://track.example.com
PASS  GET / serves the web app (200, text/html)
PASS  GET /api/auth/get-session answers JSON (sign-in is routed to the server)
PASS  GET /api/v1/openapi.json answers JSON (the REST API is routed)
PASS  WebSocket upgrade on /ws reaches the server (401 without a session, as expected)
SKIP  API token (pass --token tt_... or set TRACKYOURTIME_API_TOKEN to check one)

11 passed, 0 failed, 2 skipped
```

A failing check looks like this. These are the `FAIL` lines from a Caddy
config that sent `/api/auth` and `/api/v1` to the web app and rewrote the `/ws`
path:

```text
FAIL  GET /api/auth/get-session answered HTML (HTTP 200), not the API: /api does not reach the server
      fix: route /api/* to the server: the Caddyfile needs its handle /api/* { reverse_proxy server:5159 } block, and a proxy in front of Caddy must pass /api through, then docker compose -f docker-compose.selfhost.yml restart caddy
FAIL  GET /api/v1/openapi.json answered HTML (HTTP 200), not the API
      fix: route /api/* to the server: the Caddyfile needs its handle /api/* { reverse_proxy server:5159 } block, and a proxy in front of Caddy must pass /api through
FAIL  WebSocket upgrade on /ws was dropped (HTTP 502)
      fix: proxy /ws to the server without rewriting the path: in Caddy use handle /ws, never handle_path
```

Run the script from your own computer too. That is the only way to confirm
that the cloud provider's firewall lets traffic in. Download it into a
directory that holds no compose file:

```bash
curl -fsSL -o selfhost-check.sh https://raw.githubusercontent.com/trebeljahr/tracktime/main/scripts/selfhost-check.sh
```

```bash
bash selfhost-check.sh track.example.com
```

With no compose file in the current directory, the script skips the container
check and the IP comparison, and tests everything else from the outside. It
needs `curl`, and uses `dig` when installed.

Options:

| Option | Effect |
|---|---|
| `--token tt_…` | Also calls `GET /api/v1/me` with an API token. Create one in **Settings → Integrations → New token**. The environment variable `TRACKYOURTIME_API_TOKEN` works too. |
| `--insecure` | Accepts an untrusted certificate, for a local trial behind Caddy's internal CA. The certificate check then reports `SKIP`. |
| `APP_URL=http://localhost` | Tests that origin instead of `https://<domain>`. Read from `.env` when set there. |
| `SELFHOST_PUBLIC_IP` | The server's public IPv4, to skip the lookup at `ifconfig.me`. |
| `SELFHOST_COMPOSE_FILE` | A compose file other than `docker-compose.selfhost.yml`. |

With no domain argument, the script reads `APP_DOMAIN` from `./.env`. It reads
no other value from that file, and never prints it.

**If it fails**, follow the `fix:` line. The
[Troubleshooting](#troubleshooting) section explains each failure in more
depth.

### Step 9. Create your account

Open `https://track.example.com/signup` and fill in name, email and a password
of at least eight characters.

**Expect** to land in the app, signed in, with an empty personal workspace.

**If it fails**

| Symptom | Fix |
|---|---|
| `403` in the browser's network tab, with `INVALID_ORIGIN` | The address in your browser does not match `APP_URL`. See [`403 INVALID_ORIGIN` on sign-in](#403-invalid_origin-on-sign-in). |
| The page loads but nothing happens on submit | Run `scripts/selfhost-check.sh track.example.com`. The `/api/auth/get-session` check tells you whether sign-in reaches the server. |

Registration stays open after this. Read the next section before you leave the
instance on the internet.

### Where the images come from

The `server` and `client` services each carry both an `image:` and a `build:`
key, so `up -d` works whether or not a release exists. Compose uses the
published image for `TRACKTIME_VERSION` when it can pull one. When it cannot,
it builds from your clone. The `build:` blocks already name the right context,
Dockerfile and build arguments. One of those arguments is the empty
`NEXT_PUBLIC_API_URL`, which makes the web app use its own origin for the API.

Images for a version exist only after that tag is pushed and
[`.github/workflows/release.yml`](https://github.com/trebeljahr/tracktime/blob/main/.github/workflows/release.yml) has run. No
tag exists yet, so today every install builds locally. To avoid building on a
small server, build on another machine and push the images to your own
registry.

To force one source or the other:

```bash
docker compose -f docker-compose.selfhost.yml pull
```

```bash
docker compose -f docker-compose.selfhost.yml build
```

`pull` fetches published images only. `build` builds locally only.

Do **not** use `ghcr.io/trebeljahr/tracktime-client:main` as the self-host
client image. That is the maintainer's build, with the maintainer's API host
compiled into the browser bundle. You would get a login screen that posts to a
domain you do not own. The self-host image has the separate name
`…-client-selfhost` for exactly this reason.

---

## Accounts, and what "admin" means here

**Sign-up is open.** The server always enables email-and-password registration.
There is no allowlist, no invite code and no setup wizard. The first account is
not special. Email verification is off, so registration needs no mail provider.

**There is no instance administrator.** No account can see other people's data
or manage the instance. Every account gets its own personal workspace when it
is created. All data (clients, projects, tasks, entries, tags and invoices)
belongs to a workspace. The data model supports several members and roles per
workspace, but the web app has no screen to invite or manage members. In
practice, one account is one private workspace. You cannot invite a team
through the web app yet.

**The application cannot close registration.** There is no setting for it.
Anyone who can reach your domain can create an account. Three workarounds, from
the most practical to the most restrictive:

1. **Block the sign-up endpoint at the proxy** once your own account exists.
   Add this block to your `Caddyfile`, next to the `handle /api/*` block, then
   run `docker compose -f docker-compose.selfhost.yml restart caddy`:

   ```
   handle /api/auth/sign-up/* {
       respond "Registration is closed" 403
   }
   ```

   Caddy picks the `handle` block with the most specific path, so this block
   wins over `handle /api/*` wherever it sits. The `/signup` page still
   renders, and submitting it fails. This also blocks any account you want to
   add later, so remove the block first when you need a second one.

2. **Put the whole site behind an authentication layer:** Caddy's
   `basic_auth`, an identity-aware proxy, or a VPN such as Tailscale or
   WireGuard. This is the strongest option. It also blocks the browser
   extension and the Raycast client unless they can send the same credentials.

3. **Do not expose it publicly at all.** Bind the stack to a private network
   and reach it over a VPN. Let's Encrypt's HTTP challenge needs public
   access, so you then need a DNS challenge or an internally issued
   certificate.

**Deleting an account** is in the app: **Settings → Account → Delete
account**. An account with a password must type it. An account without one
(Google sign-in) must have signed in within the last 24 hours. Deletion signs
out every device and removes the account's data at once. There is no grace
period and no undo. A workspace that other members still use keeps its
catalog, its invoices and the entries on those invoices. Your MongoDB backups
still hold the deleted data until they expire, so rotate them if that matters
to you.

**If you lock yourself out**, see [Email](#email). Without a mail provider the
server writes the password-reset link to its log, and that is a supported way
back in.

---

## Email

### What email is used for

Three things, all about accounts: password reset, email verification (off by
default) and workspace invitations (no screen for them today). No time-tracking
feature sends mail. Reports, invoices and exports download in the browser.

So Track Your Time runs without email. You need email only to reset a password
without shell access to the server.

### Configuring SMTP

Any SMTP relay works: a mailbox provider, a transactional mail service, or an
unauthenticated relay on your own network. Set these in `.env`:

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | The relay host. Setting it selects SMTP as the transport. |
| `SMTP_PORT` | Defaults to `587` (STARTTLS). `465` is implicit TLS. `25` is an unencrypted relay. |
| `SMTP_USER` | Leave out **both** user and password for an unauthenticated relay. The server then attempts no AUTH, instead of offering empty credentials that the relay rejects. |
| `SMTP_PASSWORD` | Type it into `.env` on the server. Do not paste it into a chat. |
| `SMTP_SECURE` | `true` or `false`. When unset, it follows the port (`465` means implicit TLS). That default is right for nearly every provider. |
| `EMAIL_FROM` | Required whenever `SMTP_HOST` is set. Most relays accept only a domain they are configured to send for, so there is no useful default. |

Apply the change:

```bash
docker compose -f docker-compose.selfhost.yml up -d server
```

A missing `EMAIL_FROM` does not count as "email is not configured". A send
then fails with an error that names the host. The server does not fall back to
the log in silence. An operator who set up a relay should not have to guess why
nothing arrives. The server still writes the link to the log, so the
recovery below keeps working while you fix the relay.

### When it is not configured

Nothing breaks and nothing is queued. Sign-up needs no verification. A
password-reset request returns the usual "if this email exists…" response, and
the server prints the reset link to its log. That is how you get back into a
single-user instance you locked yourself out of:

```bash
docker compose -f docker-compose.selfhost.yml logs server | grep 'Password reset URL'
```

The line looks like `[auth] Password reset URL for you@example.com: https://…`.
Open that URL in a browser. It carries a `?token=` query parameter and lands on
`https://track.example.com/reset-password`, a real page in the web app.

### Which transport is used

SMTP wins over Listmonk whenever `SMTP_HOST` is set. The three places that send
account mail (password reset, verification and invitation) check whether *any*
transport is configured, never one provider's variables. So an instance with
SMTP set and Listmonk unset sends real mail with no further wiring.

### Verifying a send

Request a password reset for your own account at
`https://track.example.com/forgot-password`, then watch the log:

```bash
docker compose -f docker-compose.selfhost.yml logs -f server
```

A delivery failure throws, and the log shows the relay's own error with the
host and port the server tried. Nothing is swallowed. The server also prints
the link, as the same `[auth] Password reset URL for …` line. A relay that does
not work yet therefore cannot lock you out of your own instance.

---

## Why one domain, and what it would take to split

The web app is a Next.js **static export**: HTML, CSS and JavaScript files with
no Node process behind them. Next writes `NEXT_PUBLIC_*` variables into that
bundle when the image is **built**, not when it starts. A client image that
knows an API URL is bound to that host for good.

The self-host client image is therefore built with an **empty**
`NEXT_PUBLIC_API_URL`. Every call then falls back to a relative URL:

| Call | Resolves to |
|---|---|
| tRPC | `/api/trpc` |
| better-auth | `window.location.origin` + `/api/auth` |
| Live-sync WebSocket | `wss://<your host>/ws` |

Caddy makes those the same origin as the page. It sends `/api/*` and `/ws` to
the server container and everything else to the static files. This gives three
results. One image works behind anybody's domain. You need one DNS record and
one certificate instead of two. The cross-origin cookie and CORS problems
disappear.

The consequences to know about:

- The app must live at the **root** of the domain. A subpath breaks the sync
  socket, whose URL comes from the browser's origin.
- `/api/*` and `/ws` must reach the server, never the static files. Caddy
  sorts `handle` blocks by how specific their path is, so the `handle` block
  with no path always runs last, whatever its position in the file. Another
  proxy may evaluate rules in file order, and then the API rules must come
  first. A static handler that answers `/api/auth/get-session` returns
  `index.html` with a `200`. The browser shows that as a confusing sign-in
  failure, not as the routing bug it is.
- `/ws` must be proxied without rewriting the path. The server compares the
  upgrade path exactly against `/ws` and `/api/ws`, and closes the connection
  on anything else. That is why the Caddyfile uses `handle`, never
  `handle_path`.
- Your proxy must set `X-Forwarded-For`. Caddy does by default. Without it,
  better-auth cannot determine a client IP. It then turns off its own rate
  limiting on sign-in and password reset, and says so in one warning line that
  is easy to miss.

**Splitting the hosts later** is supported by the server. `FRONTEND_URL` and
`BETTER_AUTH_URL` exist for this: when set, they override the single `APP_URL`
and can name two different origins. The client half is a build-time decision,
though. You would rebuild the client image with
`NEXT_PUBLIC_API_URL=https://api.example.com`. You would add a second DNS
record and a second certificate. You would also put the extension's and any
native client's origins into `TRUSTED_ORIGINS`. Unless you have a specific reason, stay on one domain.

---

## Backup and restore

**Everything that matters is in MongoDB.** One database holds your tracked data
*and* your accounts and sessions, because better-auth uses the same
connection. A single dump is a complete backup of the instance.

The compose project is named `tracktime`, so the volumes are:

| Volume | Holds | Back up? |
|---|---|---|
| `tracktime_mongo-data` | All application and account data | Yes, but prefer `mongodump` below |
| `tracktime_mongo-config` | MongoDB's own local config | No |
| `tracktime_caddy-data` | Issued certificates and the ACME account key | Worth it, see below |
| `tracktime_caddy-config` | Caddy's autosaved config | No |
| `tracktime_redis-data` | Nothing the app reads | No |

Confirm the names on your server:

```bash
docker volume ls | grep tracktime
```

### Back up the database

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongodump --uri "mongodb://127.0.0.1:27017/tracktime" --archive --gzip > tracktime-$(date +%Y%m%d-%H%M%S).archive.gz
```

**Expect** the command to print `done dumping` lines on stderr and to leave a
non-empty `tracktime-<date>.archive.gz` in the current directory.

`mongodump` and `mongorestore` ship inside the `mongo:7.0` image, so there is
nothing to install. The dump is consistent enough for a single-node instance,
and you can take it while the stack runs. Copy the file off the server. A
backup that lives only on the VPS is not a backup.

### Restore

Stop the app so nothing writes during the restore, but leave Mongo running:

```bash
docker compose -f docker-compose.selfhost.yml stop server
```

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongorestore --uri "mongodb://127.0.0.1:27017" --archive --gzip --drop < tracktime-20260101-120000.archive.gz
```

```bash
docker compose -f docker-compose.selfhost.yml start server
```

`--drop` replaces each collection that the archive contains. Collections
created after the dump stay, which is usually what you want. For a clean
rollback to exactly the dumped state, drop the database first.

### Certificates

`tracktime_caddy-data` holds the issued certificates and the ACME account key.
Losing it is not fatal, because Caddy issues new certificates on the next
start. Each new issuance counts against Let's Encrypt's rate limits, which
matters if you rebuild a server often. To keep the volume, stop the stack first
so nothing is mid-write:

```bash
docker compose -f docker-compose.selfhost.yml down
```

```bash
docker run --rm -v tracktime_caddy-data:/data:ro -v "$PWD:/backup" alpine tar czf /backup/caddy-data.tar.gz -C /data .
```

The same `docker run … tar` pattern works for `tracktime_mongo-data` if you
prefer a file-level copy to a dump. Use it only with the stack stopped. A
`mongodump` is the more portable backup.

### What is not in the backup

Your `.env` and any edits to `Caddyfile`. Keep those in a private repository or
a password manager. `BETTER_AUTH_SECRET` in particular cannot be recovered, and
losing it signs every device out.

---

## Upgrading

Take a dump first. Always:

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongodump --uri "mongodb://127.0.0.1:27017/tracktime" --archive --gzip > pre-upgrade-$(date +%Y%m%d-%H%M%S).archive.gz
```

### Upgrading while no release exists

Today every install runs a local build of the `main` branch. An upgrade is a
newer local build. Run these from the clone directory:

```bash
git pull --ff-only
```

```bash
docker compose -f docker-compose.selfhost.yml up -d --build
```

**Expect** the build to run again, and `ps` to show five healthy services
afterwards. Run `scripts/selfhost-check.sh track.example.com` to confirm.

A local build is tagged with the value of `TRACKTIME_VERSION`. When you later
switch to a published release, run `pull` explicitly, as below. Otherwise
Compose keeps using the local image that carries the same tag.

### Upgrading to a published release

Both images carry the same tag, so one variable covers the whole stack. Set
`TRACKTIME_VERSION` in `.env` to the release you want, then:

```bash
docker compose -f docker-compose.selfhost.yml pull
```

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

Compose recreates only the containers whose image changed. Expect a few seconds
of downtime on the server container. Every connected client's sync socket
reconnects on its own afterwards. Run `scripts/selfhost-check.sh` again to
confirm.

### Which tag to pin

| Tag | Meaning |
|---|---|
| `vX.Y.Z` | An exact release. The default, and the recommendation. |
| `X.Y` | The newest patch of that minor line. |
| `latest` | The newest stable release. Prereleases never move it. |
| `:main` | **Not a release.** The maintainer's own deploy tag, built from every push to `main`. Do not set `TRACKTIME_VERSION` to it. |

### Rolling back

Set `TRACKTIME_VERSION` back to the previous release and repeat `pull` and
`up -d`. If the newer version wrote data that the older one cannot read,
restore the dump you took before upgrading (see
[Backup and restore](#backup-and-restore)).

### Migrations

**There is no migration runner, and nothing migrates at startup.** The server
boots in four steps: connect to MongoDB, connect to Redis if configured,
initialise auth, listen. No schema step exists.

Mongoose applies schema changes implicitly:

- A new field is absent on documents that older versions wrote. The code reads
  an absent field as its default rather than requiring it. This is a
  deliberate convention in this codebase.
- Mongoose creates indexes when the models register at startup.
- Nothing rewrites existing documents.

In practice, an upgrade is usually a new image and nothing more. A downgrade
usually works too, because old code ignores fields it does not know. "Usually" matters here.
No tool undoes a change that does rewrite data, which is why the `mongodump`
above is not optional.

One historical one-off script exists: `migrate:workspaces`, for databases
older than workspace scoping. Nothing runs it automatically. An instance
created from the current source or any release image does not need it.

---

## Optional integrations

Each of these is off while its variables are empty, and none runs at boot
unless configured. The app is complete without all of them.

**Redis.** Connected, but nothing reads it. Sessions live in MongoDB and live
sync fans out inside the process. The compose file includes Redis because the
server connects whenever `REDIS_URL` is set. To run the smallest possible
stack, delete three things from `docker-compose.selfhost.yml`:

- the `REDIS_URL` line in the server's `environment:` block,
- the `redis` service,
- the `depends_on` entry that waits for it.

Commenting the variable out in `.env` is not enough, because the compose file
defaults it to the bundled container. After the edit, the server logs one line
saying it skipped the connection and carries on.
`selfhost-check.sh` reads the service list from the compose file, so it then
expects four services.

**Object storage (S3).** Not used at all. The API renders invoice and report
PDFs and returns them directly. It builds CSV and JSON exports in memory, and
imports arrive in the request body. There is no bucket to provision, so do not
set up MinIO for this. The `S3_*` and `AWS_*` variables belong to the starter
this app grew from, and the self-host compose file leaves them out on purpose.

**Sentry.** Set `SENTRY_DSN` to send server errors to any Sentry-protocol
endpoint, including a self-hosted GlitchTip. Unset, nothing is reported and no
error data leaves the server.

**Google sign-in.** Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to
register the provider. With either empty, the server registers no social
provider and the web app shows no "Sign in with Google" button. Email and
password sign-in always works, so you need no OAuth app unless you want one.

**Stripe.** Subscription billing, useful only if you charge other people to use
your instance. With `STRIPE_MODE` empty the web app does not show the
subscription card. A self-hosted instance normally leaves this alone.

**Listmonk.** An alternative mail transport to SMTP, not an addition. The
maintainer's hosted deploy uses it. Its newsletter subscribe and confirm
endpoints are marketing scaffolding from the starter. The time tracker's UI
never calls them, and they do nothing while the `LISTMONK_*` variables are
unset. Prefer plain SMTP, see [Email](#email).

---

## The other clients

All of them are optional. The web app is complete on its own. None of them
needs a rebuild or a config change to use your server: the store builds of the
browser extension and the phone apps let the person choose a server, and your
server accepts them by default.

`TRUST_STORE_APPS` is `true` in `docker-compose.selfhost.yml`. It adds these
origins to the trusted list:

| Client | Origin |
|---|---|
| iOS app | `capacitor://localhost` |
| Android app | `https://localhost` |
| Chrome extension from the Web Store | `chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi` |
| Raycast extension | None. Raycast sends no `Origin`. |

To accept sign-ins from your own web app only, set `TRUST_STORE_APPS=false` in
`.env`.

**What every client checks before it saves your address.** It calls
`https://track.example.com/api/health` and shows the release the server
reports. It refuses, with a plain message:

- an address that does not answer,
- an answer that is not from Track Your Time,
- a server that cannot reach its database,
- `http://` on any host except `localhost`.

The phone apps also refuse a server that does not trust them yet, and name the
setting to change. Under a single domain, enter the bare app origin,
`https://track.example.com`, not an `api.` subdomain.

### Browser extension

1. Open the popup and choose **Change server** below the sign-in form.
2. Choose **My own server**, enter `https://track.example.com`, and confirm.
3. Chrome asks to let the extension read and change data on
   `track.example.com`. Allow it. The grant covers that one host. The extension
   asks for no other host, and has no access to any site until you choose a
   server.
4. Sign in.

**Switching servers signs the extension out** of the old server. If its offline
queue holds unsent changes, the popup shows how many and discards them only
after you confirm. The extension's queue belongs to its session.

**If you remove the extension's site access** at `chrome://extensions`, the
popup says so and offers **Allow access**.

**An extension you built yourself.** `pnpm run build:extension:prod` pins the
store key by default, so an unpacked `dist-prod/` has the store id and needs no
entry. If you build with your own `EXTENSION_KEY`, print the id with
`pnpm run extension:id prod`, add `chrome-extension://<id>` to
`TRUSTED_ORIGINS`, and run `docker compose -f docker-compose.selfhost.yml up -d server`.

### iOS and Android apps

1. On the sign-in screen, choose **Change** next to **Server**.
2. Choose **My own server**, enter `https://track.example.com`, and choose
   **Use this server**.
3. Sign in, or create an account on your server.

The app stores the choice on the device. Switching signs the app out of the old
server and clears what it cached from it.

**Offline changes stay on the device, labelled with their server.** The app
sends them only to the server they were made for, never to a different one.
Settings → Devices lists them, with a way to discard them.

A phone needs `https://` with a valid certificate. The app accepts plain
`http://` only for `localhost`, which on a phone is the phone itself.

### Raycast extension

No code change and no `TRUSTED_ORIGINS` entry. Raycast sends no `Origin` header
at all. The device-approval flow protects it instead: Raycast shows a short
code, and you approve it at `https://track.example.com/device` in a browser
where you are signed in.

Set both preference fields in Raycast Settings → Extensions → Track Your Time:

| Preference | Value under a single domain |
|---|---|
| **API URL** | `https://track.example.com` |
| **Web App URL** | `https://track.example.com`, the same value |

Left empty, they fall back to the maintainer's hosts, so fill in both.

A session belongs to the server that issued it. After you change the API URL,
Raycast asks you to pair again. Changes it queued offline wait for the server
they were queued against.

---

## Moving between hosted and self-hosted

Settings → Data → **Move to another server** copies a workspace from the server
you are signed in to onto another server. It works in both directions: from
Track Your Time cloud to your own server, and back.

**Steps**

1. Choose the target: **Track Your Time cloud**, or **My own server** and its
   address. Choose **Check server**.
2. Sign in to your account on the target, or create one there.
3. Choose **Copy**. The dialog shows the counts that arrived, and whether every
   exported entry is on the target.
4. On a phone, choose **Switch this device to** the target. In a browser, open
   the target's web app and sign in there.

**What moves:** entries, clients, projects, tasks, tags, workspace settings
(currency, rates, week start) and your pinned quick starts.

**What does not move:**

- a running timer. Stop it first.
- issued invoices. The export carries them as a record, and the import does not
  re-create them.
- clients, projects, tasks and tags that no entry uses.

**What to know**

- **It is a copy.** Nothing on the old server changes. Delete the old account
  there (Settings → Account) after you check the data on the new server.
- **You can run it again.** The target recognises entries it already has and
  skips them, so a move that stopped part-way finishes when you start it again.
- **Settings are restored only into an empty workspace.** Into a workspace that
  has entries, the move adds the entries and leaves its settings alone.
- **Large workspaces move in parts.** One import accepts 25,000 rows, so the
  move splits the history into date ranges and imports them in order.

### Direct copy, or a file

The copy runs directly from your device when the target accepts requests from
where the app runs. The phone apps qualify against a server with
`TRUST_STORE_APPS=true`. A web app on one domain usually cannot reach a server
on another, because the browser blocks it. The dialog then moves the data
through a file:

1. Choose **Download the move file**. A large workspace gives several files.
2. Open the target's web app, sign in, and go to Settings → Data →
   **Import your history**.
3. Choose the file. The preview shows what it will create. **Restore workspace
   settings** and **Restore pinned quick starts** are on when the workspace is
   empty. Import, then repeat for each file.

To copy from a web app directly, add its origin to the target's
`TRUSTED_ORIGINS` for the move, for example
`TRUSTED_ORIGINS=https://trackyourtime.dev` on your server. Remove it
afterwards.

---

## Troubleshooting

Start with the check script. It names the failing layer and prints a fix:

```bash
scripts/selfhost-check.sh track.example.com
```

### Reading the logs

```bash
docker compose -f docker-compose.selfhost.yml logs -f server
```

Replace `server` with `caddy`, `client`, `mongo` or `redis`. Add `--tail 200`
to skip old lines, and leave out `-f` to read once and exit. Which log to read:

| Symptom | Log |
|---|---|
| Sign-in, API errors, mail, password-reset links | `server` |
| Certificates, routing, `502`s, `404`s from the proxy | `caddy` |
| The web app does not load at all | `client` |
| `db: false` from `/api/health` | `mongo`, then `server` |

The state of every container, including which one is unhealthy:

```bash
docker compose -f docker-compose.selfhost.yml ps
```

### The build is killed (exit code 137)

`docker compose up -d` or `build` stops with `exit code: 137`, or the log says
`Killed`. The kernel's out-of-memory killer ended the build, almost always
during `next build` for the web app. Add a 4 GB swapfile
([Step 0.4](#step-04-add-swap-if-the-server-has-less-than-4-gb-of-ram)) and run
the command again. `dmesg | grep -i 'out of memory'` confirms the cause.

### `403 INVALID_ORIGIN` on sign-in

better-auth always checks the `Origin` header when a request carries
`Sec-Fetch-*` headers, and every real browser request does. If the browser's
origin is not in the trusted list, the server refuses sign-in before it checks
the password.

The trusted list is `FRONTEND_URL` (which `APP_URL` supplies) plus everything
in `TRUSTED_ORIGINS`. So:

- **From the web app:** your `APP_URL` does not match the address in your
  browser. The server compares the two as literal strings with no aliasing.
  `https://track.example.com` and `https://www.track.example.com` are two
  different deployments, and so are `http://localhost:8080` and
  `http://127.0.0.1:8080`. Check what the server resolved:

  ```bash
  curl -sS https://track.example.com/api/health
  ```

  The `webUrl` field is the origin it trusts. Set `APP_URL` (or `APP_DOMAIN`)
  to match your browser's address bar character for character, then run
  `docker compose -f docker-compose.selfhost.yml up -d server`.
  `selfhost-check.sh` reports this mismatch as a `webUrl` failure.

- **From the phone apps or the store extension:** check that `TRUST_STORE_APPS`
  is not `false`. An extension you built yourself needs its
  `chrome-extension://<id>` origin in `TRUSTED_ORIGINS`. See
  [The other clients](#the-other-clients).

**`curl` does not reproduce this.** curl sends no `Origin` and no `Sec-Fetch-*`
headers, so the origin check does not run. The request that fails in the
browser succeeds from the shell. Reproduce it in a browser with the network tab
open, or you will conclude that the server is fine.

Same-origin requests never produce a CORS error, so this failure shows up as a
plain `403` with no explanation in the console.

### The WebSocket does not connect

The app works, but nothing updates live across devices, and the sync status in
the app never reaches "open". `selfhost-check.sh` reports the `/ws` check as
failed when the routing is at fault.

1. **Check that nothing rewrites the path.** The server compares the upgrade
   path exactly against `/ws` and `/api/ws` and closes the connection on
   anything else, with no error the browser can explain. Behind Caddy that
   shows up as a `502`. In Caddy this means `handle /ws`, never
   `handle_path /ws`, which strips the prefix. If you put another proxy, a CDN
   or Cloudflare in front of Caddy, check it too.
2. **Check that the upgrade is forwarded.** The proxy must pass `Upgrade` and
   `Connection: Upgrade` on an HTTP/1.1 hop. Caddy's `reverse_proxy` does this
   on its own. A hand-written nginx config needs the standard `Upgrade` map.
3. **Check that `Cookie` reaches the server.** The web app authenticates the
   socket with it. A proxy that strips cookies gives you an upgrade that the
   server refuses with `401`.
4. **Check that `Sec-WebSocket-Protocol` reaches the server** if you debug the
   browser extension or Raycast. Their bearer token travels in that header.
5. **Check idle timeouts.** The server pings every 10 seconds, so any idle
   timeout above about 30 seconds is fine. An aggressive 10-second idle
   timeout on a proxy in between cuts the connection again and again.
6. **Check that the app is at the domain root.** Under a subpath the browser
   still derives `wss://<host>/ws` from its origin, which does not match where
   you mounted the app.

In the browser's network tab, filter for `ws`. A healthy request shows status
`101 Switching Protocols`.

### The certificate is not issued

The browser refuses to connect, or shows Caddy's internal certificate.
`selfhost-check.sh` reports `HTTPS certificate … is not trusted`. Read the
proxy log first:

```bash
docker compose -f docker-compose.selfhost.yml logs caddy | grep -i -E 'acme|certificate|obtain'
```

The usual causes, in the order worth checking:

| Cause | Check |
|---|---|
| DNS does not point here yet | `dig +short track.example.com` on the server, compared with `curl -4 -s https://ifconfig.me`. See [Step 1](#step-1-point-your-domain-at-the-server). |
| A stale `AAAA` record | `dig +short track.example.com AAAA` prints an address that is not this server's. Delete or correct the record. |
| Port 80 is blocked | The ACME HTTP challenge uses port 80. A firewall or security group that opens only 443 makes issuance fail. Both must be open **from the internet**. |
| Something else already owns port 80 or 443 | `docker compose … logs caddy` shows a bind error. `sudo ss -tlnp` finds the other process. |
| `APP_DOMAIN` is wrong | The site block matches it. A wrong value makes Caddy request a certificate for a name you do not control. |
| Let's Encrypt rate limits | Let's Encrypt throttles repeated failed attempts for the same name for hours. Fix the cause before you retry, rather than restarting in a loop. |

No ACME contact email is configured by default, so the CA cannot warn you if
renewals ever stop. Caddy renews well before expiry on its own. For the safety
net, add a global options block at the top of the `Caddyfile`:

```
{
    email you@example.com
}
```

### A local trial with no domain

To try the stack on your own computer with no public DNS, use one of these two
setups in `.env`:

| Setup | `.env` | Open |
|---|---|---|
| Plain HTTP | `APP_DOMAIN=http://localhost` and `APP_URL=http://localhost` | `http://localhost` |
| HTTPS with Caddy's internal certificate | `APP_DOMAIN=localhost`, and no `APP_URL` | `https://localhost`, after accepting the browser's certificate warning |

Caddy skips ACME for `localhost` in both cases. Do not combine
`APP_DOMAIN=localhost` with `APP_URL=http://localhost`. With that site address
Caddy redirects `http://localhost` to `https://localhost`, so the browser's
origin no longer matches `APP_URL` and sign-in fails with `403 INVALID_ORIGIN`.

Use one spelling consistently. `127.0.0.1` is a different origin from
`localhost` for both the session cookie and the origin check, and the server
deliberately does not treat them as the same.

Check a local trial with:

```bash
APP_URL=http://localhost scripts/selfhost-check.sh localhost
```

For the HTTPS setup, pass `--insecure` so the untrusted certificate is reported
as `SKIP`.

### MongoDB does not start

```bash
docker compose -f docker-compose.selfhost.yml logs mongo
```

| Cause | What you see, and the fix |
|---|---|
| No disk space | Mongo refuses to start or aborts on a write. Run `df -h`, then free space. |
| Unclean shutdown | Recovery messages on start. This usually resolves itself. Give the healthcheck its `start_period` before assuming a failure. |
| x86 CPU without AVX | `mongo:7.0` requires AVX. On an older or heavily virtualised x86 host it crashes immediately on start. Use a server with a newer CPU, or a managed database via `MONGODB_URI`. |
| ARM CPU older than ARMv8.2-A | The same immediate crash, for example on a Raspberry Pi 4. Use newer hardware, or a managed database via `MONGODB_URI`. |
| Volume permissions | After a manual restore of `tracktime_mongo-data` from a tarball, file ownership can be wrong. Restore with the `docker run … tar` pattern from [Backup and restore](#backup-and-restore), which keeps ownership. |
| A data directory from a different major version | Mongo refuses to start on a newer binary. Restore a `mongodump` into a fresh volume rather than upgrading in place. |

While Mongo is unhealthy the server does not start at all, because
`depends_on` waits for it. When several services are down at once, look at
`mongo` first.

### Other things worth knowing

- **`/api/…` returns the web app's HTML with a `200`.** The request reached the
  static files instead of the server. The shipped `Caddyfile` routes `/api/*`
  with a `handle /api/*` block, which Caddy always prefers to the `handle`
  block without a path. Check that the block is still there, and check any
  proxy in front of Caddy. `selfhost-check.sh` reports this on
  `/api/auth/get-session` and `/api/v1/openapi.json`.
- **Everything works but you are signed out constantly.** `BETTER_AUTH_SECRET`
  changes between restarts (an unset variable, or a regenerated one), or you
  switch between two spellings of the origin.
- **`docker compose` refuses to start with `required variable APP_DOMAIN is
  missing a value`.** The compose file stops on purpose, rather than start a
  stack that requests a certificate for an empty name. Set it in `.env`, and
  run the command from the directory that holds `.env`.
- **Sign-in rate limiting is off without a visible error.** Look for a warning
  from better-auth that it cannot determine a client IP. It means
  `X-Forwarded-For` does not reach the server. Check any proxy you put in front
  of Caddy.

---

## Reference: the files involved

| File | Role |
|---|---|
| `docker-compose.selfhost.yml` | The stack. Five services, five volumes, one set of published ports |
| `.env.selfhost.example` | Copy to `.env`. Two values are required, and the rest are commented out |
| `Caddyfile` | The single-domain routing rules: `/api/*` and `/ws` to the server, everything else to the web app |
| `scripts/selfhost-check.sh` | Verifies a running install, one `PASS`, `FAIL` or `SKIP` line per check |
| `packages/client/Dockerfile.selfhost` | Builds the web app with an empty `NEXT_PUBLIC_API_URL` and serves the static export |
| `packages/server/Dockerfile` | The server image, shared with the maintainer's deploy |
| `packages/server/.env.example` | Every server variable, with an explanation for each |
| [`.github/workflows/release.yml`](https://github.com/trebeljahr/tracktime/blob/main/.github/workflows/release.yml) | Publishes the multi-arch, version-tagged images on a `v*` tag |
| [`docs/deploy.md`](https://github.com/trebeljahr/tracktime/blob/main/docs/deploy.md) | The maintainer's own two-domain Coolify deployment, not this one |
