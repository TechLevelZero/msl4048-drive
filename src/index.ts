import { Agent, request as httpsRequest } from 'node:https';
import { constants as cryptoConstants } from 'node:crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Drives the embedded web UI of an HPE StoreEver MSL4048 tape library
 * (login.ssi / RMULogin / drive_config.ssi / RMUConfigDrive) to power
 * individual tape drives on and off. There is no vendor API for this -
 * these are the exact form posts the browser makes, reverse engineered
 * from the RMU (Remote Management Unit) web pages.
 *
 * Only drive power is touched here, never the library chassis power.
 *
 * The library only supports one logged-in RMU session at a time: a new
 * login silently kicks out whatever session was previously active,
 * without any warning to it. To make this safe when several jobs/scripts
 * on the same machine talk to the same library, every Drive instance
 * takes a cross-process file lock (see `lockFilePath`) before logging in
 * and holds it until `close()` is called, so overlapping calls queue up
 * instead of stomping on each other's session mid-operation.
 */

export type PrivilegeLevel = 'user' | 'administrator' | 'service';

const PRIVILEGE_LEVEL_CODES: Record<PrivilegeLevel, number> = {
    user: 1,
    administrator: 3,
    service: 4,
};

export interface DriveInfo {
    /** Friendly name this drive was requested/configured under. */
    name: string;
    /** Physical drive slot number, as shown on the library's own pages ("Drive 1", "Drive 2", ...). */
    slot: number;
    /** LUN used internally by the web UI's power checkbox (PWR_ON_<lun>). */
    lun: number;
    /** Whether the power-on checkbox is currently checked. */
    poweredOn: boolean;
    /** Free-text status from the library's status page (e.g. "Ready", "Offline", "Disabled"). */
    status?: string;
}

export interface TapeDriveOptions {
    /** IP address or hostname of the library's management interface. */
    host: string;
    /** Password for the chosen privilege level. */
    password: string;
    /** Defaults to 'administrator', which is required for power control. */
    privilegeLevel?: PrivilegeLevel;
    /** Defaults to 443. */
    port?: number;
    /**
     * Map of friendly drive name -> physical drive slot number, as printed
     * on the library's own Status/Configuration pages ("Drive 1", "Drive 2", ...).
     * Defaults to `{ drive1: 1 }` for single-drive libraries.
     */
    drives?: Record<string, number>;
    /** Per-request network timeout, in ms. Defaults to 15000. */
    requestTimeoutMs?: number;
    /** How long to wait for a power change to finish applying, in ms. Defaults to 5 minutes. */
    powerChangeTimeoutMs?: number;
    /** How often to poll while waiting for a power change to apply, in ms. Defaults to 10000. */
    powerChangePollIntervalMs?: number;
    /**
     * Path to a lock file/directory used to serialize access to this library
     * across processes (the library allows only one logged-in session at a
     * time). Defaults to a path under the OS temp directory, keyed by host,
     * so every Drive instance on this machine targeting the same host
     * automatically shares the same lock with no configuration needed.
     * Point multiple machines at a shared (e.g. UNC) path if more than one
     * host can reach this library.
     */
    lockFilePath?: string;
    /** How long to wait to acquire the lock before giving up, in ms. Defaults to 15 minutes. */
    lockWaitTimeoutMs?: number;
    /** How often to check whether the lock has freed up, in ms. Defaults to 2000. */
    lockPollIntervalMs?: number;
    /**
     * A lock older than this is assumed to belong to a crashed process and
     * is reclaimed rather than waited out, in ms. Defaults to 10 minutes -
     * comfortably longer than a legitimate power change can take.
     */
    lockStaleMs?: number;
}

export type PowerActionCallback = (error: Error | null, info?: DriveInfo) => void;

const DEFAULT_DRIVES: Record<string, number> = { drive1: 1 };

interface RawResponse {
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: string;
}

interface RawDriveRow {
    slot: number;
    lun: number;
    poweredOn: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

export class Drive {
    private readonly host: string;
    private readonly port: number;
    private readonly password: string;
    private readonly privilegeLevel: PrivilegeLevel;
    private readonly drives: Record<string, number>;
    private readonly requestTimeoutMs: number;
    private readonly powerChangeTimeoutMs: number;
    private readonly powerChangePollIntervalMs: number;

    private readonly lockPath: string;
    private readonly lockWaitTimeoutMs: number;
    private readonly lockPollIntervalMs: number;
    private readonly lockStaleMs: number;
    private lockHeld = false;

    private readonly agent: Agent;
    private readonly cookies = new Map<string, string>();
    private loginPromise: Promise<void> | null = null;

    constructor(options: TapeDriveOptions) {
        if (!options.host) throw new Error('Drive: "host" is required');
        if (!options.password) throw new Error('Drive: "password" is required');

        this.host = options.host;
        this.port = options.port ?? 443;
        this.password = options.password;
        this.privilegeLevel = options.privilegeLevel ?? 'administrator';
        this.drives = options.drives ?? DEFAULT_DRIVES;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
        this.powerChangeTimeoutMs = options.powerChangeTimeoutMs ?? 5 * 60_000;
        this.powerChangePollIntervalMs = options.powerChangePollIntervalMs ?? 10_000;

        this.lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? 15 * 60_000;
        this.lockPollIntervalMs = options.lockPollIntervalMs ?? 2_000;
        this.lockStaleMs = options.lockStaleMs ?? 10 * 60_000;
        this.lockPath =
            options.lockFilePath ??
            path.join(os.tmpdir(), `msl4048-drive-${this.host.replace(/[^a-zA-Z0-9.-]/g, '_')}.lock`);

        // The library's embedded webserver runs firmware old enough that it
        // needs TLS 1.2 with a relaxed security level (1024-bit cert, weak
        // DHE group) and unsafe legacy renegotiation to complete a handshake
        // at all. This agent - and its relaxed settings - is scoped to this
        // one Drive instance/host only.
        this.agent = new Agent({
            keepAlive: true,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.2',
            ciphers: 'DEFAULT@SECLEVEL=0',
            secureOptions:
                cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT |
                cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
        });
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    poweron(name: string): Promise<DriveInfo>;
    poweron(name: string, callback: PowerActionCallback): void;
    poweron(name: string, callback?: PowerActionCallback): Promise<DriveInfo> | void {
        return this.runPowerAction(name, true, callback);
    }

    poweroff(name: string): Promise<DriveInfo>;
    poweroff(name: string, callback: PowerActionCallback): void;
    poweroff(name: string, callback?: PowerActionCallback): Promise<DriveInfo> | void {
        return this.runPowerAction(name, false, callback);
    }

    /** Fetch current status for one named drive, or every configured drive. */
    status(name: string): Promise<DriveInfo>;
    status(): Promise<DriveInfo[]>;
    async status(name?: string): Promise<DriveInfo | DriveInfo[]> {
        await this.ensureLoggedIn();
        const rows = await this.fetchDriveRows();
        if (name === undefined) {
            return Object.keys(this.drives).map((n) => this.rowToInfo(n, rows));
        }
        return this.rowToInfo(name, rows);
    }

    /**
     * Log out (best-effort), release the exclusive lock on this library so
     * other processes can log in, and release the keep-alive TLS
     * connection(s) held by this instance. Always call this when done -
     * the library only allows one session at a time, so holding the lock
     * any longer than necessary blocks every other job/script targeting it.
     */
    async close(): Promise<void> {
        if (this.cookies.has('RMU_SESSIONNO')) {
            try {
                await this.rawRequest('GET', '/logout.ssi');
            } catch {
                // Best-effort - the local lock release below is what actually
                // matters for correctness, this just frees the device's
                // session slot a little sooner.
            }
        }
        this.releaseLock();
        this.agent.destroy();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    private runPowerAction(
        name: string,
        on: boolean,
        callback?: PowerActionCallback,
    ): Promise<DriveInfo> | void {
        const promise = this.setPower(name, on);
        if (callback) {
            promise.then(
                (info) => callback(null, info),
                (err) => callback(toError(err)),
            );
            return;
        }
        return promise;
    }

    private async setPower(name: string, on: boolean): Promise<DriveInfo> {
        const slot = this.slotForName(name);
        await this.ensureLoggedIn();

        const { body: configHtml } = await this.rawRequest('GET', '/drive_config.ssi');
        const rf = this.parseHiddenField(configHtml, 'rf');
        const rows = this.parseDriveRows(configHtml);
        const target = rows.find((row) => row.slot === slot);
        if (!target) {
            throw new Error(
                `Drive "${name}" (slot ${slot}) was not found on the library's drive configuration page`,
            );
        }

        // The library exposes one checkbox per drive on a single form; a
        // submit sends the checked state of every drive at once, so any
        // drive not being changed must be resubmitted with its current
        // state to avoid accidentally powering it off/on.
        const fields = new URLSearchParams();
        fields.set('rf', rf);
        for (const row of rows) {
            const checked = row.lun === target.lun ? on : row.poweredOn;
            if (checked) fields.set(`PWR_ON_${row.lun}`, 'on');
        }
        fields.set('submit', 'Submit');

        await this.rawRequest('POST', '/RMUConfigDrive', fields.toString());
        await this.waitForConfigToApply();

        const finalRows = await this.fetchDriveRows();
        return this.rowToInfo(name, finalRows);
    }

    private slotForName(name: string): number {
        const slot = this.drives[name];
        if (slot === undefined) {
            const known = Object.keys(this.drives).join(', ') || '(none configured)';
            throw new Error(`Unknown drive "${name}". Configured drives: ${known}`);
        }
        return slot;
    }

    private rowToInfo(name: string, rows: RawDriveRow[]): DriveInfo {
        const slot = this.slotForName(name);
        const row = rows.find((r) => r.slot === slot);
        if (!row) {
            throw new Error(
                `Drive "${name}" (slot ${slot}) was not found on the library's drive configuration/status pages`,
            );
        }
        return {
            name,
            slot: row.slot,
            lun: row.lun,
            poweredOn: row.poweredOn,
            status: row.status,
        };
    }

    private async fetchDriveRows(): Promise<Array<RawDriveRow & { status?: string }>> {
        const { body: configHtml } = await this.rawRequest('GET', '/drive_config.ssi');
        const rows = this.parseDriveRows(configHtml);
        const { body: statusHtml } = await this.rawRequest('GET', '/left.ssi');
        const statuses = this.parseDriveStatuses(statusHtml);
        return rows.map((row) => ({ ...row, status: statuses.get(row.slot) }));
    }

    private async waitForConfigToApply(): Promise<void> {
        const deadline = Date.now() + this.powerChangeTimeoutMs;
        while (Date.now() < deadline) {
            const { body } = await this.rawRequest('GET', '/drive_config.ssi');
            if (!body.includes('currently being updated')) return;
            await sleep(this.powerChangePollIntervalMs);
        }
        throw new Error('Timed out waiting for the MSL4048 to finish applying the drive power change');
    }

    // ---- Cross-process lock -----------------------------------------------

    private acquireLock(): Promise<void> {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + this.lockWaitTimeoutMs;

            const tryAcquire = (): void => {
                try {
                    // mkdir is atomic - exactly one concurrent caller can
                    // create a given directory, making it a serviceable mutex.
                    fs.mkdirSync(this.lockPath);
                    this.lockHeld = true;
                    resolve();
                    return;
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                        reject(toError(err));
                        return;
                    }
                }

                // Someone else holds the lock - reclaim it if it looks
                // abandoned (e.g. a previous process crashed before it
                // could call close()), otherwise wait and retry.
                try {
                    const { mtimeMs } = fs.statSync(this.lockPath);
                    if (Date.now() - mtimeMs > this.lockStaleMs) {
                        fs.rmdirSync(this.lockPath);
                        tryAcquire();
                        return;
                    }
                } catch {
                    // Lock disappeared between our mkdir failing and this
                    // stat - just retry immediately.
                    tryAcquire();
                    return;
                }

                if (Date.now() > deadline) {
                    reject(
                        new Error(
                            `Timed out after ${this.lockWaitTimeoutMs}ms waiting for exclusive access to ` +
                                `${this.host} (lock: ${this.lockPath}). Another process is likely mid-operation ` +
                                'against this library - it only supports one logged-in session at a time.',
                        ),
                    );
                    return;
                }

                setTimeout(tryAcquire, this.lockPollIntervalMs);
            };

            tryAcquire();
        });
    }

    private releaseLock(): void {
        if (!this.lockHeld) return;
        try {
            fs.rmdirSync(this.lockPath);
        } catch {
            // Already gone - nothing left to clean up.
        }
        this.lockHeld = false;
    }

    // ---- Session / login ------------------------------------------------

    private async ensureLoggedIn(): Promise<void> {
        if (this.cookies.has('RMU_SESSIONNO')) return;
        if (!this.loginPromise) this.loginPromise = this.login();
        try {
            await this.loginPromise;
        } finally {
            this.loginPromise = null;
        }
    }

    private async login(): Promise<void> {
        // The library only allows one active session; hold this lock for
        // the rest of this instance's life (released in close()) so no
        // other process can log in - and silently kick us out - while
        // we're mid-operation.
        await this.acquireLock();

        // The login page's own JavaScript writes these three throwaway
        // cookies right before submitting the form; the server rejects the
        // POST outright without them (checked server-side, not just client).
        this.cookies.set('cockiecheck1', 'testcookie1');
        this.cookies.set('cockiecheck2', 'testcookie2');
        this.cookies.set('cockiecheck3', 'testcookie3');

        const levelCode = PRIVILEGE_LEVEL_CODES[this.privilegeLevel];

        // Despite the login form rendering separate password inputs per
        // privilege level (password / adminpassword / servicepassword), the
        // credential for every level is actually submitted in "password";
        // the other two fields are sent empty. Verified against firmware
        // 9.60 by comparing the browser's own submitted form data.
        const body = new URLSearchParams({
            user_level: String(levelCode),
            password: this.password,
            adminpassword: '',
            servicepassword: '',
            login: 'Log in',
        }).toString();

        const { body: loginResponse } = await this.rawRequest('POST', '/RMULogin', body);

        if (loginResponse.includes('Incorrect password')) {
            throw new Error(`MSL4048 login failed: incorrect ${this.privilegeLevel} password`);
        }

        // On success the response is a script that sets RMU_LEVEL/RMU_LOGIN
        // via document.cookie rather than a Set-Cookie header, so they have
        // to be scraped out of the body by hand.
        for (const cookieName of ['RMU_LEVEL', 'RMU_LOGIN']) {
            const match = loginResponse.match(new RegExp(`${cookieName}=([^;"]+)`));
            if (!match) {
                throw new Error(
                    `MSL4048 login response did not include a ${cookieName} cookie ` +
                        '(unexpected response - check credentials/privilege level, or firmware version)',
                );
            }
            this.cookies.set(cookieName, match[1]);
        }

        const redirectMatch = loginResponse.match(/location\s*=\s*'([^']+)'/i);
        const nextPage = redirectMatch ? redirectMatch[1] : `loginlevel${levelCode}.ssi`;

        // This request is what actually earns the real session cookie
        // (RMU_SESSIONNO), issued as a normal Set-Cookie header.
        await this.rawRequest('GET', `/${nextPage}`);

        if (!this.cookies.has('RMU_SESSIONNO')) {
            throw new Error('MSL4048 login did not establish a session (no RMU_SESSIONNO cookie)');
        }
    }

    // ---- HTML scraping ---------------------------------------------------

    private parseHiddenField(html: string, field: string): string {
        const match = html.match(new RegExp(`name="${field}"\\s+value=("?)([^">]+)\\1`, 'i'));
        if (!match) {
            throw new Error(`drive_config.ssi is missing the expected hidden field "${field}"`);
        }
        return match[2];
    }

    private parseDriveRows(html: string): RawDriveRow[] {
        const rows: RawDriveRow[] = [];
        const rowRe = /Drive\s+(\d+)\s*\(LUN\)[\s\S]*?name="PWR_ON_(\d+)"([\s\S]*?)>/gi;
        let match: RegExpExecArray | null;
        while ((match = rowRe.exec(html))) {
            rows.push({
                slot: Number(match[1]),
                lun: Number(match[2]),
                poweredOn: /CHECKED/i.test(match[3]),
            });
        }
        return rows;
    }

    private parseDriveStatuses(html: string): Map<number, string> {
        const statuses = new Map<number, string>();
        const re = /Drive\s+(\d+)\s+Status<\/B><\/TD>\s*<TD[^>]*>(?:<IMG[^>]*>\s*)?([A-Za-z]+)/gi;
        let match: RegExpExecArray | null;
        while ((match = re.exec(html))) {
            statuses.set(Number(match[1]), match[2]);
        }
        return statuses;
    }

    // ---- transport --------------------------------------------------------

    private cookieHeader(): string {
        return Array.from(this.cookies.entries())
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    private captureSetCookies(setCookie: string[] | undefined): void {
        if (!setCookie) return;
        for (const raw of setCookie) {
            const [pair] = raw.split(';');
            const eq = pair.indexOf('=');
            if (eq === -1) continue;
            this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }

    private rawRequest(method: string, path: string, body?: string): Promise<RawResponse> {
        return new Promise((resolve, reject) => {
            const headers: OutgoingHttpHeaders = {
                Cookie: this.cookieHeader(),
            };
            if (body !== undefined) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                headers['Content-Length'] = Buffer.byteLength(body);
            }

            const req = httpsRequest(
                {
                    agent: this.agent,
                    host: this.host,
                    port: this.port,
                    path,
                    method,
                    headers,
                    timeout: this.requestTimeoutMs,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        this.captureSetCookies(res.headers['set-cookie']);
                        resolve({
                            statusCode: res.statusCode ?? 0,
                            headers: res.headers,
                            // The library serves iso-8859-1; latin1 decodes it 1:1.
                            body: Buffer.concat(chunks).toString('latin1'),
                        });
                    });
                },
            );

            req.on('timeout', () => req.destroy(new Error(`Request to ${path} timed out`)));
            req.on('error', reject);
            if (body !== undefined) req.write(body);
            req.end();
        });
    }
}

export default Drive;
