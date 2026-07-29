# Disaster Recovery

Backup, restore and recovery for the Expert Safety CRM. Written to be followed by someone who did
not write the code, on a bad day, under pressure.

## What we are protecting against

| Scenario | Realistic? | Covered by |
|---|---|---|
| Someone deletes a customer / task / certificate by mistake | **Most likely event** | Daily JSON backup — restore one collection |
| A bad script or migration corrupts many rows | Likely | Daily JSON backup + Atlas point-in-time |
| Atlas cluster lost, account suspended, billing lapse | Rare, fatal | **Off-Atlas JSON backup** — the copy the vendor does not control |
| Laptop dies / repo lost | Likely | Git remote |
| Ransomware on the office machine | Possible | Off-site copy that is not a mounted drive |

Atlas takes its own snapshots, and they are the fastest route back for most incidents. They are not
sufficient alone: a backup that can only be restored by the vendor who lost your data is a
dependency, not a backup. The daily JSON dump is the copy that survives losing the Atlas account
entirely.

## Objectives

- **RPO (max acceptable data loss): 24 hours** from the JSON backup; near-zero from Atlas PITR.
- **RTO (max acceptable downtime): 2 hours** — the app is a Vercel redeploy, so recovery time is
  dominated by restoring data, not code.

## Daily backup

```bash
npm run backup                 # → ./backups/YYYY-MM-DD_HHMMSS/, prunes older than 14 days
npm run backup -- --keep 30    # keep a month
npm run backup:gzip            # compress (Media_Store dominates the size)
npm run backup -- --out D:/CRM_Backups
```

Read-only against the database — safe to run against production, which matters because dev and
production share one Atlas cluster.

Each run writes one JSON file per collection plus `_manifest.json` (document counts and byte sizes
per collection). **The manifest is the integrity check**: if a restore's counts disagree with it,
the dump is incomplete — do not proceed.

### Scheduling it (Windows Task Scheduler)

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "scripts/backup-db.js --gzip --keep 30" `
  -WorkingDirectory "C:\Users\DELL\Desktop\CRM 150726\Expert CRM 2026"
$trigger = New-ScheduledTaskTrigger -Daily -At 9:30PM
Register-ScheduledTask -TaskName "ExpertCRM-DailyBackup" -Action $action -Trigger $trigger `
  -Description "Nightly JSON backup of the CRM database"
```

21:30 IST is after the working day, so a backup captures a complete day of job cards and challans.

> **Do not schedule this as a Vercel cron.** Vercel Hobby allows one cron per day, serverless
> functions have a short execution ceiling and an ephemeral filesystem, and a dump written there
> disappears with the invocation. Backups belong on a machine that keeps its disk.

### Off-site copy — the step people skip

A backup on the same machine as the operator survives neither theft nor ransomware. After the
nightly run, copy `backups/` to something the machine does not control: an external drive that is
**unplugged between runs**, or a cloud sync folder (Google Drive / OneDrive).

Keep the retention window on the off-site copy **longer** than local. Corruption is often noticed
weeks later, and a 14-day window that has already rotated past the last good copy is no help.

> The dumps contain complete customer, staff, salary and pricing records in plaintext. Treat the
> backup folder with the same care as the database. `.gitignore` already excludes `backups/`; never
> force-add it — anything committed survives in git history long after it is deleted.

## Restoring

**Always dry-run first.** It is the default.

```bash
# 1. See what would change — writes nothing
npm run restore -- --from backups/2026-07-29_213000

# 2. Rehearse into a scratch database
npm run restore -- --from backups/2026-07-29_213000 \
  --to mongodb://localhost:27017/crm_restore_test --confirm-overwrite

# 3. Recover a single collection (the common real case)
npm run restore -- --from backups/2026-07-29_213000 --only Task_Master --confirm-overwrite \
  --i-know-this-is-production
```

Guards, in order:

1. Dry-run is the default; `--confirm-overwrite` is required to write.
2. Targeting the `MONGO_URI` in `server/.env` additionally requires `--i-know-this-is-production`.
3. Each dump is parsed **before** the existing collection is cleared, so a truncated file aborts
   rather than destroying good data.

`--only` is what you want in nearly every real incident. Restoring everything rolls back all
collections to the backup time, discarding a day of unrelated work to fix one deleted row.

### Before restoring over production

Take a fresh backup first. Recovering from a mistaken restore requires the state you are about to
overwrite.

```bash
npm run backup -- --out ./backups/pre-restore
```

## Recovering the application

The code is stateless; all state is in MongoDB.

```bash
git clone <remote-url> && cd "Expert CRM 2026"
npm install && npm --prefix server install
# recreate server/.env from server/.env.example — MONGO_URI and JWT_SECRET are mandatory
npm run build
```

Set every variable from `server/.env.example` in the Vercel dashboard. `.env` is never committed,
so **it will not come back from git** — keep a copy in a password manager. Losing `JWT_SECRET` is
survivable: setting a new one invalidates existing sessions and everyone logs in again.

## Code versioning

```bash
git add -A && git commit -m "..."   # commit locally, frequently
git push origin main                # only when you intend to deploy
```

Pushing `main` triggers a Vercel production deploy — the repository is also the deployment
trigger, so a push is a release. Tag anything you may need to roll back to:

```bash
git tag -a v1.4.0 -m "Security hardening" && git push origin v1.4.0
```

Verify a remote actually exists (`git remote -v`). A repo with no remote is one disk failure from
total loss.

## Quarterly restore drill

Backups fail silently. Test them on a schedule, not after an incident.

1. `npm run backup`
2. Restore into a scratch database (`--to`, step 2 above)
3. Point a local server at it and log in; open a task, a job card and a certificate
4. Confirm document counts against `_manifest.json`
5. Record the date and result below

| Date | Backup tested | Result | By |
|---|---|---|---|
| _(fill in at first drill)_ | | | |

## Incident checklist

1. **Stop the bleeding.** If a script is corrupting data, stop it before recovering anything.
2. **Do not take a "clean" backup over a good one.** Backing up corrupted data can rotate the last
   good copy out of the retention window.
3. Identify the last good backup — check `_manifest.json` counts against what you expect.
4. Dry-run the restore.
5. Restore the narrowest thing that fixes it (`--only`).
6. Verify in the app before telling anyone it is fixed.
7. Write down what happened and what would have caught it earlier.
