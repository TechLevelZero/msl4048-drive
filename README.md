# msl4048-drive

Programmatic power control for individual tape drives in an **HPE StoreEver
MSL4048** tape library. HPE/BDT never shipped an API for this — the library
only exposes an embedded web UI (the "RMU", Remote Management Unit) — so this
module drives that web UI directly: it logs in the same way a browser does
and submits the same form the Configuration → Drive page submits.

Only drive power is touched. The library chassis itself is never powered on
or off.

## Install

This is a local module, not published to npm. Point your project at the
folder directly, e.g. in another project's `package.json`:

```json
"dependencies": {
    "msl4048-drive": "file:../tapeDev/msl4048-drive"
}
```

To build compiled JS + type declarations (requires `npm install typescript`
in this folder first):

```bash
npm install typescript --save-dev
npm run build
```

For quick local testing without a build step, Node 22.6+ can run the
TypeScript source directly — see `example.ts`.

## Configuration

Copy `.env.example` to `.env` and fill in your library's details. `.env` is
gitignored — never commit real credentials.

```bash
cp .env.example .env
```

```
MSL4048_HOST=<library-ip-or-hostname>
MSL4048_PASSWORD=<administrator-password>
MSL4048_PRIVILEGE_LEVEL=administrator
MSL4048_DRIVES=drive1=1
```

## Quick start

```typescript
import { Drive } from 'msl4048-drive';

const tape = new Drive({
    host: process.env.MSL4048_HOST!,
    password: process.env.MSL4048_PASSWORD!,
    privilegeLevel: 'administrator', // required for power control; this is the default
    drives: { drive1: 1, drive2: 2 }, // friendly name -> physical drive slot number
});

// await / Promise style
const info = await tape.poweron('drive1');
// { name: 'drive1', slot: 1, lun: 2, poweredOn: true, status: 'Ready' }

// callback style
tape.poweroff('drive1', (err, info) => {
    if (err) throw err;
    console.log(info);
});

// status
await tape.status('drive1'); // one drive
await tape.status();         // every configured drive

tape.close(); // release the keep-alive TLS connection when you're done
```

Run `example.ts` for a full working demo:

```bash
node --env-file=.env example.ts
```

## Command-line use

`src/cli.ts` wraps `Drive` as a small CLI (`cli.js <on|off|status> [driveName]`,
config via environment variables) for use from schedulers/orchestrators
that can only call an executable rather than import a module — e.g. Veeam's
pre-job/post-job script hooks. See [VEEAM.md](./VEEAM.md) for a worked
example of powering the drive on before a File to Tape job and off again
after it finishes.

## API

### `new Drive(options)`

| Option                       | Type                     | Default             | Notes                                                              |
| ----------------------------- | ------------------------ | -------------------- | ------------------------------------------------------------------- |
| `host`                        | `string`                 | *(required)*          | IP or hostname of the library's management interface.                |
| `password`                    | `string`                 | *(required)*          | Password for the chosen `privilegeLevel`.                            |
| `privilegeLevel`              | `'user' \| 'administrator' \| 'service'` | `'administrator'`    | Power control requires `'administrator'` or higher.                  |
| `port`                        | `number`                 | `443`                 | |
| `drives`                      | `Record<string, number>` | `{ drive1: 1 }`      | Friendly name → **physical drive slot number**, exactly as printed on the library's own pages ("Drive 1", "Drive 2", ...). |
| `requestTimeoutMs`            | `number`                 | `15000`               | Per-HTTP-request timeout.                                             |
| `powerChangeTimeoutMs`        | `number`                 | `300000` (5 min)      | How long to wait for a power change to finish applying.               |
| `powerChangePollIntervalMs`   | `number`                 | `10000`               | How often to poll while waiting.                                      |

### `tape.poweron(name)` / `tape.poweroff(name)`

Powers the named drive on or off.

- Call with one argument to get a `Promise<DriveInfo>` back — `await` it.
- Call with a second, callback argument — `(err, info) => void` — to use
  error-first callback style instead. In that form the method returns
  `void`.

Powering a drive up or down on this hardware takes real time (observed:
up to a few minutes) while the library re-scans it, so both styles only
resolve/call back once the change has actually finished applying.

### `tape.status(name?)`

- `tape.status('drive1')` → `Promise<DriveInfo>` for that one drive.
- `tape.status()` → `Promise<DriveInfo[]>` for every drive listed in the
  `drives` option.

### `DriveInfo`

```typescript
{
    name: string;       // the friendly name you called it with
    slot: number;       // physical drive slot number (matches the library's own UI)
    lun: number;        // internal LUN used by the web UI's power checkbox
    poweredOn: boolean;
    status?: string;    // e.g. "Ready", "Offline", "Disabled"
}
```

### `tape.close()`

Releases the keep-alive TLS connection held by this `Drive` instance. Call
it when you're done, especially in short-lived scripts, so the process can
exit.

## How `drives` mapping works

You configure drives by the **slot number** shown on the library's own
Status/Configuration pages ("Drive 1", "Drive 2", ...) — not the internal
LUN the web form actually posts (`PWR_ON_<lun>`). The module reads the
Configuration → Drive page itself to work out which LUN backs which slot,
so you never need to know or hard-code that mapping.

## Why the TLS handshake needs special handling

This library runs firmware old enough (BDT/HPE RMU, tested against
firmware 9.60) that a modern OpenSSL/Node TLS stack refuses it outright by
default:

- Its certificate uses a 1024-bit RSA key.
- It offers a weak DHE group.
- It has no TLS 1.3 support.
- It requires "unsafe legacy renegotiation" to be allowed.

`Drive` works around this by giving each instance its own `https.Agent`
configured with `TLSv1.2` max, `ciphers: 'DEFAULT@SECLEVEL=0'`, and the
`SSL_OP_LEGACY_SERVER_CONNECT` / `SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION`
options — scoped to that one instance, not applied globally to your
process.

## Login quirks handled internally

The RMU login flow doesn't behave like a normal cookie-based session, and
`Drive` papers over all of this so you don't have to think about it:

1. The login page's own JavaScript writes three throwaway cookies
   (`cockiecheck1/2/3`) right before submitting the form; the server
   rejects the login POST without them.
2. On success, the response sets its real-looking cookies
   (`RMU_LEVEL`, `RMU_LOGIN`) via an inline `document.cookie` script, not a
   `Set-Cookie` header — they have to be scraped out of the HTML.
3. The actual session cookie (`RMU_SESSIONNO`) is only issued once you
   follow through to the post-login redirect page.
4. Regardless of which privilege level you log in as, the password value
   goes in a form field literally named `password` — the `adminpassword`
   / `servicepassword` fields the login page also renders are always sent
   empty. (Verified by capturing the browser's own submitted form data.)

## Security note

The password is passed as a plain constructor option — never hard-code it
in source. Use `.env` (see Configuration above) for local development, or
a proper secrets manager / your scheduler's own secret store in
production. `.env` is gitignored by default; double-check it never ends
up committed or copied into a script's saved configuration (see
[VEEAM.md](./VEEAM.md) for how that applies to Veeam's script hooks).

## Multi-drive libraries

The library's power form has one checkbox per drive, and submitting it
sends the checked state of *every* drive at once. `Drive` handles this
for you: when you power one drive on or off, it re-reads the current
state of all other configured drives first and resubmits their state
unchanged, so toggling `drive1` never accidentally affects `drive2`.
