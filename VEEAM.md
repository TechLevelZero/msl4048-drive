# Powering the tape drive on/off around a Veeam job

This wires `Drive` into Veeam's own **pre-job / post-job script** hooks, so
Veeam powers the drive on before a File to Tape job runs and off again once
it finishes — no change to how the job is scheduled or run.

Veeam's script hooks call an executable, not a JS module, so use
`scripts/tape-power.bat` — a single batch file that takes the action and
drive name as arguments (`tape-power.bat <on|off|status> [driveName]`)
and wraps the `src/cli.ts` CLI, which wraps `Drive`.

## 1. Run it

`tape-power.bat` runs `src\cli.ts` directly — Node 22.6+ executes
TypeScript with no build step needed, so there's nothing to compile for
this to work. If you'd rather run compiled JS instead, `npm install
typescript --save-dev && npm run build` produces `dist/cli.js`; edit
`tape-power.bat` to point at that instead of `src\cli.ts` if you do.

## 2. Set connection details in a `.env` file on the Veeam server

The CLI deliberately takes **no password on the command line** — Veeam
stores script paths/arguments in the job configuration and logs them, and
a password there would be visible to anyone who can view the job. Instead,
copy `.env.example` to `.env` in the project root (one level up from
`scripts/`) on the machine that runs the Veeam job, and fill in real
values:

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
C:\Scripts\msl4048-drive\scripts\tape-power.bat status drive1
```

**If this fails with exit code 9009 when run from Veeam but works fine in
your own `cmd`/PowerShell**: that's Windows saying `node` couldn't be
found. It works interactively because your user's `PATH` includes it —
the Veeam Backup Service runs as a different account (its own service
account, or `SYSTEM`) with a different `PATH` that usually doesn't.
`tape-power.bat` auto-detects a standard Node.js installer location, but
if that doesn't match your setup (nvm, a per-user install, a zip
extract), run `where node` in your own `cmd` to find the real path and
hardcode it into the `NODE_EXE` line near the top of `tape-power.bat`.

## 3. Configure the job's pre-job / post-job scripts

In the File to Tape job's properties, open **Advanced settings** and look
for a **Scripts** (or similarly named) tab — the exact label and
availability vary by Veeam version, so check your job's Advanced settings
dialog if the name below doesn't match exactly. Point both fields at the
same file, `scripts\tape-power.bat`, with different arguments:

**Run the following script before the job:**

```
Path:      C:\Scripts\msl4048-drive\scripts\tape-power.bat
Arguments: on drive1
```

**Run the following script after the job:**

```
Path:      C:\Scripts\msl4048-drive\scripts\tape-power.bat
Arguments: off drive1
```

If your Veeam version's script field is a single path with no separate
arguments box, put the whole thing in that one field instead, e.g.
`C:\Scripts\msl4048-drive\scripts\tape-power.bat on drive1`.

If your Veeam version offers a checkbox like **"Run post-job script only
if the job completes successfully"**, leave it **unchecked** — you want
the drive powered back off even if the tape job fails partway through.

## 4. What actually happens at each step

- **Pre-job**: `tape-power.bat on drive1` logs in, submits the power-on
  request, and then polls the library until it reports the drive as done
  reconfiguring (this library can take a few minutes to spin up and come
  `Ready`) before exiting `0`. Veeam won't start the File to Tape job
  until this script exits, so the drive is guaranteed to be up before the
  backup starts writing to it.
- **Post-job**: `tape-power.bat off drive1` does the same in reverse once
  the backup job itself has finished.
- A non-zero exit code (`1` runtime error, `2` usage/config error) tells
  Veeam the script failed; check the job's log or Windows Event Log for
  the message the CLI printed to stderr. `tape-power.bat` forwards the
  CLI's exit code with `exit /b %ERRORLEVEL%`.

## 5. Multiple drives

If the library has more than one drive and the job only uses one of them,
set `MSL4048_DRIVES` to include all of them (e.g. `drive1=1,drive2=2`) so
`Drive` can correctly preserve the other drive's power state when it
toggles the one being used. For a second drive's job, just change the
argument, e.g. `tape-power.bat on drive2` — the same `tape-power.bat`
handles every drive.

## 6. Multiple Veeam jobs against the same library

This library only allows **one logged-in session at a time**: if two
scripts log in around the same time, the second one silently kicks the
first one's session out mid-operation — confirmed directly against the
hardware, not a theoretical concern. Since a power-on/off can take a few
minutes, this matters as soon as more than one job's pre/post scripts (or
someone checking `status` by hand) can overlap in time — e.g. two File to
Tape jobs on staggered schedules, or a job that overruns into the next
one's start time.

The CLI handles this automatically: each invocation takes an exclusive
lock (a plain file, under the OS temp directory by default) before
logging in, and only releases it once it logs out at the end. A second
job's script trying to run at the same time will simply wait for the
first to finish rather than colliding — you don't need to stagger job
schedules by hand to avoid this.

The one case that needs an extra step: if File to Tape jobs for this
library run from **more than one Veeam server/proxy**, a local temp-dir
lock on one machine can't be seen by the other. Set `MSL4048_LOCK_FILE` in
each machine's `.env` to the same shared path (e.g. a UNC path both can
reach) so they share one lock instead of each only serializing its own
jobs:

```
MSL4048_LOCK_FILE=\\fileserver\share\msl4048-drive.lock
```
