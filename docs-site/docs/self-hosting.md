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
Coolify, documented in [`deploy.md`](https://github.com/trebeljahr/trackyourtime/blob/main/docs/deploy.md). Nothing here interacts with
it.

**One thing to check before you start.** The compose file pulls the published
images for one release tag and never builds them. Releases are the `v*` tags
listed on the repository's Releases page, starting with `v0.1.0`. If the tag
you want has no published images, `docker compose pull` stops with a registry
error, and the only way to run that version is to build both images yourself
([Where the images come from](#where-the-images-come-from)). That build needs
about 4 GB of memory, or less RAM plus swap
([Step 0.4](#step-04-add-swap-if-you-build-the-images-yourself)).

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
Set up Track Your Time on my Ubuntu server at <domain>, following https://github.com/trebeljahr/trackyourtime/blob/main/docs/self-hosting.md. Run scripts/selfhost-check.sh <domain> at the end and show me its output.
```

Before you send it, make sure the assistant has these:

| It needs | Why |
|---|---|
| SSH access to the server, as root or as a user with `sudo` | It installs Docker, clones the repository and starts the containers. |
| A DNS `A` record for the domain that already points at the server | Certificate issuance fails until the record resolves. Add an `AAAA` record too if the server has IPv6. |
| Ports 80 and 443 open in your cloud provider's firewall | The assistant can open the server's own firewall. It usually cannot reach the provider's control panel. |
| SMTP credentials, optionally | Only for password-reset mail and timer reminders. The app works without them. See [Email](#email). |

The assistant does **not** need an account with any service. There is no
registry login, no API key, no licence key and no sign-up with a third party.
Everything it downloads comes from public URLs: the Docker install script, the
GitHub repository, the app images on `ghcr.io` and the public MongoDB, Redis
and Caddy images on Docker Hub.

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
| `server` | `ghcr.io/trebeljahr/trackyourtime-server` | The API (tRPC and REST), authentication and the live-sync WebSocket. |
| `client` | `ghcr.io/trebeljahr/trackyourtime-client-selfhost` | The web app: a static export served by a second, small Caddy. |
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
| RAM, pulling the published images (the default) | 1 GB works for a single user. 2 GB is comfortable. MongoDB uses the most. |
| RAM, building the images yourself (opt-in) | 4 GB, or less RAM plus a swapfile. `next build` for the web app uses the most memory, and the kernel kills it on a 1 GB server with no swap. Running the stack afterwards needs only the 1–2 GB above. |
| Time for the first start | Mostly download time when you pull, so it depends on your connection. Later starts use the local copies and take seconds. Building the images yourself takes much longer, and is slowest on 1 vCPU. |
| Disk | 5 GB for images and volumes, plus your data. Time entries are small. A heavy year of tracking takes megabytes. A local build needs several GB more for the build cache, which `docker builder prune` frees afterwards. |
| CPU | 1 vCPU is enough to run it. PDF and CSV generation is the only bursty work at runtime. |

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
| Outbound access to `ghcr.io` and Docker Hub | For the first start and for every upgrade. Restarts use the local copies of the images. |
| 1–2 GB of memory | Enough to pull and run the published images. Building the images yourself needs about 4 GB, RAM plus swap. See the limit at the top of this guide. |

**ARM servers.** Each release tag covers `linux/amd64` and `linux/arm64`, and
Docker pulls the one that matches the server, so an ARM server runs a native
image with no emulation. A local build also runs natively on ARM, because
every base image is multi-arch. 32-bit ARM is not published. MongoDB 7.0 on
ARM needs an ARMv8.2-A CPU or newer. An Ampere VPS, a Raspberry Pi 5 and an
Apple-silicon machine qualify. A Raspberry Pi 4 or older does not.

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

#### Step 0.4. Add swap if you build the images yourself

Skip this step if you pull the published images, which is the default. Pulling
and running the stack fits in 1–2 GB.

Building the images on the server is opt-in
([Where the images come from](#where-the-images-come-from)), and the web-app
build needs about 4 GB of memory. RAM plus swap counts.

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
git clone https://github.com/trebeljahr/trackyourtime.git
```

```bash
cd trackyourtime
```

Then check out the release you will run. The compose file and the images must
come from the same release, and `TRACKYOURTIME_VERSION` in `.env.selfhost.example`
names it:

```bash
git checkout "$(sed -n 's/^TRACKYOURTIME_VERSION=//p' .env.selfhost.example)"
```

**Expect** `git describe --tags` to print the same tag, for example `v0.1.0`,
and `ls docker-compose.selfhost.yml Caddyfile .env.selfhost.example` to print
the three file names with no error.

The stack reads only those three files. The clone also brings
`scripts/selfhost-check.sh`, which [Step 8](#step-8-verify-the-install) runs,
and the source that an opt-in local build needs.

**If it fails**

| Symptom | Fix |
|---|---|
| `fatal: destination path 'trackyourtime' already exists` | A clone is already there. Run `cd trackyourtime`, `git fetch --tags`, and continue. |
| `Could not resolve host: github.com` | The server has no outbound DNS or internet access. Fix the network first. |
| `error: pathspec 'v…' did not match any file(s) known to git` | That release has not been published. Stay on `main` and see the limit at the top of this guide. |

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
| `TRACKYOURTIME_VERSION` | The release tag of both app images, already set to the release the example file shipped with. Change it only to upgrade or roll back. See [Upgrading](#upgrading). |
| `APP_URL` | Only when the origin is not `https://${APP_DOMAIN}`: a plain-HTTP local trial, or a non-standard port. |
| `SMTP_*`, `EMAIL_FROM` | Only for outgoing mail. See [Email](#email). |
| `TRUST_STORE_APPS` | Only to refuse the phone apps and the store extension. It is `true` by default. See [The other clients](#the-other-clients). |
| `TRUSTED_ORIGINS` | Only for an extension you built yourself, or a web app that copies data in directly. See [The other clients](#the-other-clients). |
| `MONGODB_URI`, `REDIS_URL` | Only to use a managed database instead of the containers. |

The app must run at the **root** of the domain. Hosting it under
`https://example.com/trackyourtime/` breaks live sync: the browser derives the
WebSocket URL from its origin, which still resolves to `example.com/ws`.

**If it fails**

| Symptom | Fix |
|---|---|
| `grep` prints nothing | The `APP_DOMAIN=` line is missing or commented out. Add `APP_DOMAIN=track.example.com` to `.env` on its own line. |
| The value contains `https://` or a `/` | Remove them. `APP_DOMAIN` is the host name only. |

### Step 6. Start the stack

**Run** the pull on its own first. It downloads every image and starts
nothing, so a problem with the images shows up before any container exists:

```bash
docker compose -f docker-compose.selfhost.yml pull
```

**Expect** one `Pulled` line per service and exit status `0`. Compose pulls
`ghcr.io/trebeljahr/trackyourtime-server` and
`ghcr.io/trebeljahr/trackyourtime-client-selfhost` at the tag in
`TRACKYOURTIME_VERSION`, and `mongo`, `redis` and `caddy` from Docker Hub. Docker
picks the `amd64` or `arm64` variant that matches the server. This step is
most of the first start's time, and how long it takes depends on your
connection. Nothing is built.

**Run**

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

**Expect** the command to end with one line per container, such as
`✔ Container trackyourtime-server-1  Started` or `Healthy`. Its exit status is
`0`. Later starts use the local images and take seconds.

If you build the images yourself instead, run the build command from
[Where the images come from](#where-the-images-come-from) in place of both
commands above.

To avoid typing `-f docker-compose.selfhost.yml` on every command, export it
once per shell:

```bash
export COMPOSE_FILE=docker-compose.selfhost.yml
```

The rest of this guide keeps the flag, so every block works when pasted.

**If it fails**

| Symptom | Fix |
|---|---|
| `manifest unknown`, or `…: not found` | No image has this tag. `TRACKYOURTIME_VERSION` is misspelled, or that release was never published. Compare it with `git tag`. Nothing was built and no container started. |
| `denied`, or `unauthorized` | The image package does not exist or is not public. Check that the image names in `docker-compose.selfhost.yml` are unedited. You do not need a registry login, so do not add one. |
| `dial tcp`, `i/o timeout`, or `no such host` for `ghcr.io` or `registry-1.docker.io` | The server cannot reach the registry. Check outbound DNS and HTTPS, then run `pull` again. |
| `exit code: 137`, or `Killed`, during a build | You ran the opt-in local build and the kernel stopped it because memory ran out. Add swap ([Step 0.4](#step-04-add-swap-if-you-build-the-images-yourself)) and run the build command again. The finished build stages are cached. |
| `required variable APP_DOMAIN is missing a value` | Compose found no `.env` with `APP_DOMAIN` in the current directory. `cd` into the clone, or repeat [Step 5](#step-5-set-your-domain). The compose file stops on purpose rather than request a certificate for an empty name. |
| `required variable BETTER_AUTH_SECRET is missing a value` | Repeat [Step 4](#step-4-generate-the-session-secret). |
| `Bind for 0.0.0.0:80 failed: port is already allocated`, or `address already in use` | Another program owns port 80 or 443, often a web server installed with the OS image. `sudo ss -tlnp` lists every listening program. Find the one on `:80` or `:443` and stop it. |
| `no space left on device` | The disk is full. After a local build, the build cache is the usual cause: run `docker builder prune`. Free space, and run the command again. |
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
{"status":"ok","db":true,"webUrl":"https://track.example.com","version":"<40-character commit hash>","timestamp":"2026-09-13T12:00:00.000Z"}
```

- `status` is `ok` when the server answers.
- `db` is `true` when MongoDB is connected.
- `webUrl` is the origin the server derived from `APP_URL`. It must match what
  you type in the browser, character for character. Fix it now if it does not,
  rather than debugging sign-in later.
- `version` is the commit the server image was built from. A published release
  image carries it, so it tells you exactly which release runs. For `v0.1.0`
  it equals the output of `git rev-list -n 1 v0.1.0`. An image you built
  yourself has an empty `version`, and that is expected.

**Run** this to confirm that both app images were pulled from the registry,
not built on the server:

```bash
docker image inspect --format '{{.RepoDigests}}' "ghcr.io/trebeljahr/trackyourtime-server:$(sed -n 's/^TRACKYOURTIME_VERSION=//p' .env)" "ghcr.io/trebeljahr/trackyourtime-client-selfhost:$(sed -n 's/^TRACKYOURTIME_VERSION=//p' .env)"
```

**Expect** two lines, each holding one or more
`ghcr.io/trebeljahr/…@sha256:…` entries. A pulled image records the registry
digest it came from. A locally built image has no digest, and is named
`trackyourtime-server:local` or `trackyourtime-client-selfhost:local` instead of the
`ghcr.io` names, so `docker image inspect` reports `No such image` for the
`ghcr.io` name when you built.

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
curl -fsSL -o selfhost-check.sh https://raw.githubusercontent.com/trebeljahr/trackyourtime/main/scripts/selfhost-check.sh
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

**Run** the server's own configuration check, from the clone directory:

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js doctor
```

**Expect** no `FAIL` line. `WARN  mail` is normal when SMTP is not configured.
The script above tests the install from the outside. `doctor` tests it from
inside the server container: the database, Redis, the trusted origins, the
auth URL and the clock. See [`doctor`](#doctor).

### Step 9. Create your account

Open `https://track.example.com/signup` and fill in name, email and a password
of at least eight characters.

**Expect** to land in the app, signed in, with an empty personal workspace.

To create the account without a browser, use the admin CLI instead. It asks
for the password twice and does not show it:

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js create-user --email you@example.com --name "Your Name"
```

See [The admin CLI](#the-admin-cli) for the other commands.

**If it fails**

| Symptom | Fix |
|---|---|
| `403` in the browser's network tab, with `INVALID_ORIGIN` | The address in your browser does not match `APP_URL`. See [`403 INVALID_ORIGIN` on sign-in](#403-invalid_origin-on-sign-in). |
| The page loads but nothing happens on submit | Run `scripts/selfhost-check.sh track.example.com`. The `/api/auth/get-session` check tells you whether sign-in reaches the server. |

Registration stays open after this. Read the next section before you leave the
instance on the internet.

### Where the images come from

**By default, from the registry.** The `server` and `client` services name the
published images `ghcr.io/trebeljahr/trackyourtime-server:${TRACKYOURTIME_VERSION}` and
`ghcr.io/trebeljahr/trackyourtime-client-selfhost:${TRACKYOURTIME_VERSION}`. Each tag
covers `linux/amd64` and `linux/arm64`, and Docker pulls the one that matches
the server. The images for a release exist once its tag is pushed and
[`.github/workflows/release.yml`](https://github.com/trebeljahr/trackyourtime/blob/main/.github/workflows/release.yml) has run.
No registry login is needed.

Both services set `pull_policy: missing` and have no `build:` section. So:

- The first `pull` or `up -d` downloads both images. So does the first one
  after you change `TRACKYOURTIME_VERSION`, because a new tag is a new image.
- Every other start uses the local copy and does not contact the registry.
- When an image cannot be pulled, `pull` and `up -d` stop with the registry's
  error. Nothing is built and no container starts. The
  [Step 6](#step-6-start-the-stack) table lists the errors and their causes.

**Why there is no automatic build fallback.** Compose treats a failed pull
differently when a service also has a `build:` section: it ignores the error
and builds from source, whatever `pull_policy` says. A typo in the tag would
then start a `next build` that needs 4 GB of memory. On the 1–2 GB server this
stack is sized for, the kernel kills that build, and nothing on screen says
why. Building is therefore a separate, deliberate step.

**Building the images yourself.** Use this when you changed the source, when
the server cannot reach `ghcr.io`, or when you want a version that has no
published images. You need the clone from [Step 2](#step-2-get-the-files),
checked out at the version you want, and about 4 GB of memory, RAM plus swap
([Step 0.4](#step-04-add-swap-if-you-build-the-images-yourself)).

**Run** this from the clone, in place of `pull` and `up -d`:

```bash
docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml up -d --build
```

**Expect** a much longer first run than a pull. The web-app build is the
slowest and most memory-hungry part. The command ends with the same one line
per container as [Step 6](#step-6-start-the-stack).

`docker-compose.selfhost.build.yml` builds from the same Dockerfiles the
release workflow uses, including the empty `NEXT_PUBLIC_API_URL`, which makes
the web app use its own origin for the API. Every `up` with this file rebuilds,
from the build cache when nothing changed, so an edited checkout never keeps
running a stale image. Both compose files must stay in the root of the clone.

The local images are named `trackyourtime-server:local` and
`trackyourtime-client-selfhost:local`, never the `ghcr.io` names. A local build
therefore cannot sit under a release tag and stop the real image from being
pulled later. To go back to the published images, run the commands from
[Step 6](#step-6-start-the-stack) without the second `-f`. Compose then pulls
the `ghcr.io` images and recreates both containers.

**If you ran this stack before `v0.1.0` was published.** Earlier versions of
the compose file built the images on the server under the `ghcr.io` names. A
server that did that already holds a local image called
`ghcr.io/trebeljahr/trackyourtime-server:v0.1.0`, and `pull_policy: missing` keeps
using it: `pull` prints `Skipped - Image is already present locally`. Replace
the local build with the published image once:

```bash
docker compose -f docker-compose.selfhost.yml pull --policy always
```

Then run `up -d`. The repo-digest check in
[Step 8](#step-8-verify-the-install) confirms the containers now run the
published images.

To build the two local images without starting or restarting anything:

```bash
docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml build
```

Do **not** use `ghcr.io/trebeljahr/trackyourtime-client:main` as the self-host
client image. That is the maintainer's build, with the maintainer's API host
compiled into the browser bundle. You would get a login screen that posts to a
domain you do not own. The self-host image has the separate name
`…-client-selfhost` for exactly this reason.

---

## Accounts, and what "admin" means here

**Sign-up is open.** The server always enables email-and-password registration.
There is no allowlist, no invite code and no setup wizard. The first account is
not special. Email verification is on only when a mail transport is
configured, so registration without a mail provider needs no mail.

**Two-factor authentication** is in the app: **Settings → Account →
Two-factor authentication**. It uses an authenticator app (TOTP) and ten
single-use backup codes. After it is on, every web sign-in asks for a code.
The mobile app and the browser extension cannot sign in to an account with
two-factor authentication yet; they show an error instead. Devices that are
already signed in stay signed in. The Raycast client pairs through a browser
that is already signed in, so it is not affected. Turning it off needs the
password. If a person loses both the app and the backup codes, nobody on the
instance can switch it off for them from the web app; the database record is
the `twoFactor` document with their `userId`, and `twoFactorEnabled` on their
`user` document.

**Google sign-in** needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The
redirect URI to register with Google is
`https://track.example.com/api/auth/callback/google`. Without both variables
the button on `/login` and `/signup` stays disabled. It is always disabled in
the mobile and desktop apps, because Google returns to the web address and
cannot return to the app.

**Administration is a command, not an account.** No account can see other
people's data or manage the instance. The person who can run commands in the
server container is the administrator, through
[the admin CLI](#the-admin-cli). Every account gets its own personal workspace
when it is created. All data (clients, projects, tasks, entries, tags and
invoices) belongs to a workspace. An owner or admin invites people from the
Members screen, and each member sees only their own time until an owner or admin
opens up colleagues' time. Only an owner can open up colleagues' money. If the
server has no email settings, the Members screen shows the invitation link to
copy and send by hand.

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

**If you lock yourself out**, set a new password with
[`reset-password`](#reset-password). The server log also holds a reset link
when no mail provider is configured. See [Email](#email).

### The admin CLI

The server image contains a command-line tool for the instance. Run it inside
the `server` container, from the clone directory:

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js <command>
```

The tool uses the server's own configuration and databases. It opens no port
and makes no request outside your stack. It sends no telemetry and does not
check for updates. Anyone who can run `docker compose exec` on the server can
use it, so protect SSH access to the server.

| Command | Effect |
|---|---|
| `create-user --email <address> --name <name>` | Creates an account and its personal workspace. |
| `reset-password --email <address>` | Sets a new password and signs the account out on every device. |
| `list-workspaces` | Lists every workspace with its id, name, member count and owner email. |
| `doctor` | Checks the configuration and the services, one `PASS`, `WARN` or `FAIL` line each. |
| `help` | Shows the commands and their options. |

Exit status: `0` on success, `1` when the command fails or a `doctor` check
fails, `2` when the arguments are wrong. `list-workspaces` and `doctor` accept
`--json` for output that a script can read.

From a checkout with a local server configuration, the same commands run as
`pnpm --filter @starter/server admin <command>`.

#### Passwords

`create-user` and `reset-password` ask for the password twice and do not show
it. The password rules are the same as on the sign-up page: at least eight
characters.

Two other ways to give the password, for scripts:

- On standard input, with `-T` so that Compose does not attach a terminal. The
  first line is the password:

  ```bash
  printf '%s\n' "$NEW_PASSWORD" | docker compose -f docker-compose.selfhost.yml exec -T server node dist/cli/admin.js reset-password --email you@example.com
  ```

- With `--password <password>`. The password is then in your shell history.
  Use this only for throwaway accounts.

#### `create-user`

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js create-user --email ada@example.com --name "Ada Lovelace"
```

**Expect:**

```text
Created ada@example.com (user 6650f0c2a1b2c3d4e5f60718) with personal workspace 6650f0c2a1b2c3d4e5f6071b.
```

The account is created the same way as on the sign-up page, so the person can
sign in at once. The command fails when an account with that email exists.
Registration does not need to be open: the command works when you block the
sign-up endpoint at the proxy.

#### `reset-password`

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js reset-password --email ada@example.com
```

**Expect:**

```text
Set a new password for ada@example.com and signed out 3 sessions.
```

Every session of the account is deleted. The mobile apps, the browser
extension and the Raycast extension are signed out at the next request, and
open live-sync connections close within a minute. A browser tab can keep
working for up to five minutes from its cached session. The command also works
for an account that signed up with Google and has no password yet: it adds one.

#### `list-workspaces`

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js list-workspaces
```

**Expect:**

```text
ID                        NAME                      MEMBERS  OWNER
6650f0c2a1b2c3d4e5f6071b  Ada Lovelace's workspace  1        ada@example.com
```

An owner of `(no owner)` means that no member of the workspace has the owner
role. That can happen when an account deletion stops before it finishes.

#### `doctor`

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js doctor
```

**Expect** output like this from a healthy install without SMTP:

```text
PASS  database         MongoDB answered a ping in 3 ms
PASS  redis            Redis answered PING
WARN  mail             no mail transport; password-reset links are written to the server log
                       fix: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM to send mail
PASS  trusted-origins  https://track.example.com is trusted
PASS  auth-url         https://track.example.com is well-formed and is the app origin
PASS  clock            this process is 2 ms behind the database server

0 failed, 1 warned, 5 passed.
```

| Check | Passes when | Fails when |
|---|---|---|
| `database` | MongoDB answers a ping at `MONGODB_URI`. | MongoDB does not answer within five seconds. |
| `redis` | Redis answers `PING` at `REDIS_URL`. `WARN` when `REDIS_URL` is empty. | `REDIS_URL` is set and Redis does not answer. The server does not start in that state. |
| `mail` | A mail transport is configured. `WARN` when none is. | `SMTP_HOST` is set and `EMAIL_FROM` is empty. |
| `trusted-origins` | The origin of `APP_URL` is in the trusted origins exactly as a browser sends it. `WARN` when a `TRUSTED_ORIGINS` entry has a path or a trailing slash. | The origin is missing, or is present only with a trailing slash or a path. Sign-in then fails with `403 INVALID_ORIGIN`. |
| `auth-url` | `BETTER_AUTH_URL` is a valid URL on the app's origin. `WARN` for a path, or for plain `http` on a public host. | `BETTER_AUTH_URL` is missing, does not parse, or has a different origin from `APP_URL`. |
| `clock` | The server's clock is within 30 seconds of MongoDB's. `WARN` up to five minutes. | The clocks differ by five minutes or more. |

`doctor` sends no email. To test mail delivery, see
[Verifying a send](#verifying-a-send).

---

## Email

### What email is used for

Four things about accounts: password reset, email verification (on only
when a transport is configured), the link that confirms a new email address,
and workspace invitations (without email, the Members screen shows the link
to copy). One thing about time tracking: a single reminder for a timer left
running too long. Reports, invoices and exports download in the browser.

The reminder goes out once per timer. It is sent when the runaway guard flags
a timer (behaviour "Ask me"), or when a timer passes 8 hours with the guard
off. A background job checks every 5 minutes. With no SMTP configured, the
server logs the reminder instead of sending it. Each person can turn the
reminder off with **Email notifications** in Settings, Account. The job also
applies "Cap it" and "Stop it" with no app open. `SCHEDULER_ENABLED=false`
turns the job off; the guard then applies only when an app next asks for the
running timer.

So Track Your Time runs without email. You need email only to reset a password
without shell access to the server, and to receive timer reminders.

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

Nothing breaks and nothing is queued. Sign-up needs no verification. A change
of email in **Settings → Account** writes its confirmation link to the log as
`[auth] Verification URL for …`, and the email changes when that link is
opened. A password-reset request returns the usual "if this email exists…" response, and
the server prints the reset link to its log. That is how you get back into a
single-user instance you locked yourself out of:

```bash
docker compose -f docker-compose.selfhost.yml logs server | grep 'Password reset URL'
```

The line looks like `[auth] Password reset URL for you@example.com: https://…`.
Open that URL in a browser. It carries a `?token=` query parameter and lands on
`https://track.example.com/reset-password`, a real page in the web app.

With shell access to the server, [`reset-password`](#reset-password) is faster.
It needs no link and no browser.

### Configuring mail on an instance that already has accounts

When a transport is configured, the server requires a verified email address
before a password sign-in. Accounts created while mail was off are not
verified, so they would get a verification link instead of a session. Mark
them verified once, right after you restart with the mail variables set:

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/scripts/backfill-email-verified.js
```

It prints how many accounts it changed. It marks accounts created before the
moment it runs. To exclude accounts created after the restart, pass the
restart time: `--before 2026-09-14T12:00:00Z`. Running it again changes
nothing and prints 0.

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

The compose project is named `trackyourtime`, so the volumes are:

| Volume | Holds | Back up? |
|---|---|---|
| `trackyourtime_mongo-data` | All application and account data | Yes, but prefer `mongodump` below |
| `trackyourtime_mongo-config` | MongoDB's own local config | No |
| `trackyourtime_caddy-data` | Issued certificates and the ACME account key | Worth it, see below |
| `trackyourtime_caddy-config` | Caddy's autosaved config | No |
| `trackyourtime_redis-data` | Nothing the app reads | No |

Confirm the names on your server:

```bash
docker volume ls | grep trackyourtime
```

### Back up the database

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongodump --uri "mongodb://127.0.0.1:27017/trackyourtime" --archive --gzip > trackyourtime-$(date +%Y%m%d-%H%M%S).archive.gz
```

**Expect** the command to print `done dumping` lines on stderr and to leave a
non-empty `trackyourtime-<date>.archive.gz` in the current directory.

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
docker compose -f docker-compose.selfhost.yml exec -T mongo mongorestore --uri "mongodb://127.0.0.1:27017" --archive --gzip --drop < trackyourtime-20260101-120000.archive.gz
```

```bash
docker compose -f docker-compose.selfhost.yml start server
```

`--drop` replaces each collection that the archive contains. Collections
created after the dump stay, which is usually what you want. For a clean
rollback to exactly the dumped state, drop the database first.

### Certificates

`trackyourtime_caddy-data` holds the issued certificates and the ACME account key.
Losing it is not fatal, because Caddy issues new certificates on the next
start. Each new issuance counts against Let's Encrypt's rate limits, which
matters if you rebuild a server often. To keep the volume, stop the stack first
so nothing is mid-write:

```bash
docker compose -f docker-compose.selfhost.yml down
```

```bash
docker run --rm -v trackyourtime_caddy-data:/data:ro -v "$PWD:/backup" alpine tar czf /backup/caddy-data.tar.gz -C /data .
```

The same `docker run … tar` pattern works for `trackyourtime_mongo-data` if you
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
docker compose -f docker-compose.selfhost.yml exec -T mongo mongodump --uri "mongodb://127.0.0.1:27017/trackyourtime" --archive --gzip > pre-upgrade-$(date +%Y%m%d-%H%M%S).archive.gz
```

### Upgrading to a published release

Both app images carry the same tag, so one variable covers the whole stack.
The compose file and `Caddyfile` can change between releases too, so move the
clone to the same tag first. Run these from the clone directory, with
`vX.Y.Z` replaced by the release you want:

```bash
git fetch --tags
```

```bash
git checkout vX.Y.Z
```

If you edited `Caddyfile` and the new release changes it, `git checkout`
refuses and names the file. Run `git stash`, repeat the checkout, then run
`git stash pop` and resolve any conflict in `Caddyfile`.

Set `TRACKYOURTIME_VERSION=vX.Y.Z` in `.env`, then:

```bash
docker compose -f docker-compose.selfhost.yml pull
```

**Expect** exit status `0`. `pull` downloads the new images while the old
containers keep running. When the tag does not exist, it stops with
`not found` before anything restarts, so a typo in `TRACKYOURTIME_VERSION` costs
no downtime.

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

Compose recreates only the containers whose image or configuration changed.
The server is unavailable while its container restarts. Every connected
client's sync socket reconnects on its own afterwards. Run
`scripts/selfhost-check.sh track.example.com` again to confirm, and check that
`version` in `/api/health` changed (see [Step 8](#step-8-verify-the-install)).

### Upgrading when you build the images yourself

Check out the new tag as above, or pull the branch you build from, then
rebuild:

```bash
docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml up -d --build
```

**Expect** the build to run again, and `ps` to show five healthy services
afterwards.

### Which tag to pin

| Tag | Meaning |
|---|---|
| `vX.Y.Z` | An exact release. The default, and the recommendation. |
| `vX.Y.Z-rc.N` | A prerelease. Published under this exact tag only. It never moves `X.Y` or `latest`. |
| `X.Y` | The newest stable patch release of that minor line. |
| `latest` | The newest stable release. |
| `:main` | **Not a release.** The maintainer's own deploy tag, built from every push to `main`. Do not set `TRACKYOURTIME_VERSION` to it. |

The release workflow publishes in this order. It pushes the exact `vX.Y.Z` tag
for both images first. It then pulls that tag with no registry login and
starts this compose stack from it, once on `amd64` and once on `arm64`. `X.Y`
and `latest` move to the new release only after both starts pass. A release
that fails that check therefore never becomes `latest`, though its exact tag
stays published.

### Rolling back

Check out the previous tag, set `TRACKYOURTIME_VERSION` back to it, and repeat
`pull` and `up -d`. If you build the images yourself, check out the previous
tag and run the build command instead.

A rollback can end in one of two ways:

- **The older server starts.** Every migration the newer version ran is one
  older versions can read. Nothing else to do.
- **The older server refuses to start** and logs `This database was migrated
  by a newer Track Your Time (vX.Y.Z)`. That version ran a migration that
  older versions misread, so the older server stops before it serves a single
  request. Restore the dump you took before upgrading (see
  [Backup and restore](#backup-and-restore)), or go forward to vX.Y.Z again.

To see which case applies before you roll back, run
`node dist/cli/admin.js migrate --status` in the newer container. The first
line names the schema each side needs.

### Migrations

The server migrates its own database at startup. After it connects to
MongoDB, and before it accepts a connection, it takes three steps:

1. **It checks that it can read the database.** Every migration records the
   oldest schema that can still read the data after it ran. If the database
   needs a newer schema than this version has, the server logs which release
   migrated it and exits with status 1.
2. **It applies pending migrations, in order.** Each one is recorded in the
   `schema_migrations` collection with the time and the release that applied
   it. A lock in the `app_meta` collection keeps two server processes from
   running migrations at the same time; the second one waits. A migration that
   fails is not recorded: the server exits, and the next start runs it again.
3. **It builds every index and reports each failure.** A unique index usually
   fails because duplicate documents already exist. If that index guards data
   integrity (one running timer per person, one membership per person and
   workspace, unique invoice numbers, unique scheduled jobs, unique API token
   prefixes), the server logs the index and the reason and exits. Other index
   failures are logged as warnings. The server never drops an index.

Most releases add no migration, and most migrations stay readable by older
versions. The runner changes nothing about the rule above: **take a
`mongodump` before every upgrade.** No tool undoes a migration.

Look before you upgrade, or migrate without starting the server:

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js migrate --status
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js migrate --dry-run
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js migrate
```

`--status` lists applied and pending migrations. `--dry-run` lists what would
run and changes nothing. With neither flag, the command applies pending
migrations exactly as a server start does. All three exit with status 1 when
the database needs a newer release. `doctor` also reports the schema state
and any missing index.

New fields need no migration. A field added in a new version is absent on
older documents, and the code reads an absent field as its default. Old code
ignores fields it does not know.

Two one-off scripts exist. `backfill-email-verified` marks existing accounts
verified when you configure mail; see
[Configuring mail on an instance that already has accounts](#configuring-mail-on-an-instance-that-already-has-accounts).
`migrate:workspaces` is for databases older than workspace scoping. Nothing runs it automatically. An instance
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
set up MinIO for this. The server reads no `S3_*` or `AWS_*` variables.

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
code, and you approve it at `https://track.example.com/app/device` in a browser
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

Then check the server's configuration from inside the container:

```bash
docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js doctor
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

### `pull` or `up` stops with a registry error

The default compose file never builds, so an image it cannot pull stops the
command, and no container starts. Read the last error line and match it
against the table in [Step 6](#step-6-start-the-stack): `not found` is a tag
that does not exist, `denied` is an image that is not public, and a DNS or
timeout error is a network problem. Fix the cause and run `pull` again. Do not
add a `build:` section to `docker-compose.selfhost.yml` to get past it; use
the opt-in build file from
[Where the images come from](#where-the-images-come-from).

### The build is killed (exit code 137)

This happens only with the opt-in local build.
`docker compose … up -d --build` or `build` stops with `exit code: 137`, or
the log says `Killed`. The kernel's out-of-memory killer ended the build,
almost always during `next build` for the web app. Add a 4 GB swapfile
([Step 0.4](#step-04-add-swap-if-you-build-the-images-yourself)) and run
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

Both setups assume Caddy answers on port 80 (and 443). If you map it to
another host port, `APP_URL` must be the exact address in the browser,
port included, for example `APP_URL=http://localhost:8080`. Without the port,
sign-in fails with `403 INVALID_ORIGIN`.

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
| Volume permissions | After a manual restore of `trackyourtime_mongo-data` from a tarball, file ownership can be wrong. Restore with the `docker run … tar` pattern from [Backup and restore](#backup-and-restore), which keeps ownership. |
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
| `docker-compose.selfhost.yml` | The stack. Five services, five volumes, one set of published ports. Pulls the published images and never builds |
| `docker-compose.selfhost.build.yml` | Opt-in override that builds the two app images from the clone instead of pulling them. Needs about 4 GB of memory |
| `.env.selfhost.example` | Copy to `.env`. Two values are required, and the rest are commented out |
| `Caddyfile` | The single-domain routing rules: `/api/*` and `/ws` to the server, everything else to the web app |
| `scripts/selfhost-check.sh` | Verifies a running install, one `PASS`, `FAIL` or `SKIP` line per check |
| `packages/client/Dockerfile.selfhost` | Builds the web app with an empty `NEXT_PUBLIC_API_URL` and serves the static export |
| `packages/server/Dockerfile` | The server image, shared with the maintainer's deploy |
| `packages/server/.env.example` | Every server variable, with an explanation for each |
| `packages/server/src/cli/admin.ts` | The admin CLI, compiled into the server image as `dist/cli/admin.js` |
| `docker-compose.selfhost.ci.yml` | CI override: runs the stack with images built from the checkout, on `localhost` |
| [`.github/workflows/selfhost-smoke.yml`](https://github.com/trebeljahr/trackyourtime/blob/main/.github/workflows/selfhost-smoke.yml) | Boots the stack on pull requests that change it, and runs `doctor`, `create-user` and `reset-password` against it |
| [`.github/workflows/release.yml`](https://github.com/trebeljahr/trackyourtime/blob/main/.github/workflows/release.yml) | On a `v*` tag, builds both images for `amd64` and `arm64`, pushes the exact tag, starts the stack from an anonymous pull on both, then moves `X.Y` and `latest` |
| [`docs/deploy.md`](https://github.com/trebeljahr/trackyourtime/blob/main/docs/deploy.md) | The maintainer's own two-domain Coolify deployment, not this one |
