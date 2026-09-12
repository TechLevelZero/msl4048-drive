# Powering the tape drive on/off around a Veeam job

This wires `Drive` into Veeam's own **pre-job / post-job script** hooks, so
Veeam powers the drive on before a File to Tape job runs and off again once
it finishes — no change to how the job is scheduled or run.

Veeam's script hooks call an executable, not a JS module, so use the small
CLI wrapper at `src/cli.ts` rather than importing `Drive` directly.

## 1. Build (or run the source directly)

```bash
npm install typescript --save-dev
npm run build
```

This produces `dist/cli.js`. If you'd rather skip the build step, Node
22.6+ can run `src/cli.ts` directly — just point Veeam at `src/cli.ts`
instead of `dist/cli.js` below.

## 2. Set connection details in a `.env` file on the Veeam server

The CLI deliberately takes **no password on the command line** — Veeam
stores script paths/arguments in the job configuration and logs them, and
a password there would be visible to anyone who can view the job. Instead,
copy `.env.example` to `.env` next to `dist/cli.js` on the machine that
runs the Veeam job, and fill in real values:

```
MSL4048_HOST=<library-ip-or-hostname>
MSL4048_PASSWORD=<administrator-password>
MSL4048_PRIVILEGE_LEVEL=administrator
MSL4048_DRIVES=drive1=1
```

This file holds a plaintext password, so lock down its NTFS permissions
to just the account the Veeam Backup Service runs as, plus admins — and
make sure it's excluded if this folder is ever synced/copied from a
source-controlled deployment (it's already in `.gitignore`).

Verify from an elevated `cmd`/PowerShell prompt before wiring it into
Veeam:

```bat
node --env-file=C:\Scripts\msl4048-drive\.env C:\Scripts\msl4048-drive\dist\cli.js status drive1
```

## 3. Configure the job's pre-job / post-job scripts

In the File to Tape job's properties, open **Advanced settings** and look
for a **Scripts** (or similarly named) tab — the exact label and
availability vary by Veeam version, so check your job's Advanced settings
dialog if the name below doesn't match exactly.

**Run the following script before the job:**

```
Path:      C:\Program Files\nodejs\node.exe
Arguments: --env-file=C:\Scripts\msl4048-drive\.env "C:\Scripts\msl4048-drive\dist\cli.js" on drive1
```

**Run the following script after the job:**

```
Path:      C:\Program Files\nodejs\node.exe
Arguments: --env-file=C:\Scripts\msl4048-drive\.env "C:\Scripts\msl4048-drive\dist\cli.js" off drive1
```

If your Veeam version offers a checkbox like **"Run post-job script only
if the job completes successfully"**, leave it **unchecked** — you want
the drive powered back off even if the tape job fails partway through.

## 4. What actually happens at each step

- **Pre-job**: `cli.js on drive1` logs in, submits the power-on request,
  and then polls the library until it reports the drive as done
  reconfiguring (this library can take a few minutes to spin up and come
  `Ready`) before exiting `0`. Veeam won't start the File to Tape job
  until this script exits, so the drive is guaranteed to be up before the
  backup starts writing to it.
- **Post-job**: `cli.js off drive1` does the same in reverse once the
  backup job itself has finished.
- A non-zero exit code (`1` runtime error, `2` usage/config error) tells
  Veeam the script failed; check the job's log or Windows Event Log for
  the message the CLI printed to stderr.

## 5. Multiple drives

If the library has more than one drive and the job only uses one of them,
set `MSL4048_DRIVES` to include all of them (e.g. `drive1=1,drive2=2`) so
`Drive` can correctly preserve the other drive's power state when it
toggles the one being used — then just pass the specific drive name
(`on drive1`) in the script arguments for that job.
