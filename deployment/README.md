# StudyMed Oracle production deployment

This folder is only for the Oracle A1 VM described by P014. It runs one internal
Node backend and one public Caddy gateway. The backend has no published host port.

## Required VM files

- `/opt/studymed/app`: clone of this repository.
- `/opt/studymed/secrets/backend.env`: copied manually from the existing production
  environment, mode `0600`. Set `FRONTEND_URL=https://tranmed-api.duckdns.org`.
- `/opt/studymed/secrets/gateway.env`: based on `gateway.env.example`, mode `0600`.

For the first connectivity deployment, set `WORKER_ENABLED=false` in
`backend.env`. This is a hard safety gate: startup does not recover leases, clean
temporary data, or claim queue jobs, and job-mutating API calls return `503`.
Set it back to `true` only after the P014 purge has completed and its dry-run scope
has been verified.

## Deployment

Run `bash deployment/deploy.sh` on the VM. It only uses `git pull --ff-only`; it drains
an existing backend through its internal maintenance API before replacing it and
cancels that pause if a pre-replacement step fails. The GitHub Actions workflow
runs tests before it calls this script over SSH.

`/api/health` and `/api/readiness` are the only anonymous routes. Every other
static or API route is behind Caddy Basic Auth. Generate the Caddy password hash on
the VM; never commit the plaintext password or either production env file.

## P014 irreversible cleanup

From the backend directory on the VM, first run:

```bash
npm run purge:p014:dry
```

Only after the reported scope is correct and all `incoming/` objects are safe to
discard, use the separate shell confirmation and CLI flag:

```bash
P014_PURGE_CONFIRM=DELETE_WORK_DATA npm run purge:p014
```

The script deletes R2 `incoming/` objects first, confirms the prefix is empty, then
deletes only MongoDB `TranslationChunk`, `Job`, and `UploadBatch` collections. It
does not touch `System`, `GeminiQuotaState`, or `GeminiSchedulerState`.
