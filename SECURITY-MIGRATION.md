# Security baseline migration

These changes require an explicit rollout to affect running containers or deployed services.

## Development infrastructure

MongoDB, Redis and local S3 publications now bind `127.0.0.1`. Existing
volumes and port overrides remain unchanged. Schedule a development-container
recreation to apply this. Keep the existing volumes.
After recreation, inspect Docker's published bindings and host listeners.
Remote development clients need an authenticated tunnel instead of a public port.

## Build contexts

Docker ignore rules now exclude nested dotenv files, private keys, and local
build inputs. This prevents future build-context inclusion; it does not erase
old builder caches or prove previous images contained secrets. Inspect existing
images and caches separately. Rotate only credentials confirmed exposed, through
their established owner-approved procedure. Keep private key files owner-readable only.

## Auth links and account migration

Auth links are bearer credentials. Production no longer logs them automatically.
`AUTH_LOG_LINKS=true` explicitly permits owner recovery through private server
logs, including mail failure paths. Keep it off on hosted/multi-user services;
remove it after recovery, and control log access and retention. Development and
test environments keep their local fallback. With no permitted fallback, auth
mail fails without logging a recipient or token.

Track Your Time retains its transport-dependent verification policy and its
admin CLI `reset-password` recovery path. Mail-free self-hosting remains
supported. To retain log-based recovery deliberately, set `AUTH_LOG_LINKS=true`
in the server environment and recreate the server during an approved rollout.
The self-host Compose variable defaults to false. No existing accounts are
modified.

## Dependencies and validation

Dependency manifests and lockfiles must be deployed together. Rebuild images
and clients from the tested commit before rollout. A clean audit does not prove
all dependency code safe, and static exports do not expose a Next.js optimizer.
Run `node --test scripts/security-baseline.test.mjs` from the app root on Node 24.
For Hatchkit, the app root is `starter/`; generated PostgreSQL and account-security
variants also require the CLI's isolated regression runner.

Rollback is a local revert of the security commit followed by an explicitly
approved deployment. Reverting restores the old exposure and logging behavior;
prefer fixing configuration or using the documented opt-ins.
