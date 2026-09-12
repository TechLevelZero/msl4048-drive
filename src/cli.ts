#!/usr/bin/env node
/**
 * Command-line wrapper around the Drive class, meant to be called from
 * an external scheduler/orchestrator (e.g. Veeam's pre-job/post-job
 * script hooks) that can only invoke an executable, not import a module.
 *
 * All connection settings come from environment variables rather than
 * command-line arguments, so a password never has to appear in a job's
 * saved configuration or its logs.
 *
 * Usage:
 *   cli.js on <driveName>
 *   cli.js off <driveName>
 *   cli.js status [driveName]
 *
 * Environment variables:
 *   MSL4048_HOST             library IP/hostname (required)
 *   MSL4048_PASSWORD         password for MSL4048_PRIVILEGE_LEVEL (required)
 *   MSL4048_PRIVILEGE_LEVEL  user | administrator | service (default: administrator)
 *   MSL4048_DRIVES           comma list of name=slot, e.g. "drive1=1,drive2=2" (default: drive1=1)
 *   MSL4048_LOCK_FILE        path to the cross-process lock (default: auto, per-host, under the OS temp dir)
 *                            - set this to a shared/UNC path if more than one machine talks to the library
 *
 * Exit codes: 0 success, 1 runtime/library error, 2 usage error.
 */
import { Drive, type PrivilegeLevel } from './index.ts';

function parseDrives(spec: string): Record<string, number> {
    const drives: Record<string, number> = {};
    for (const entry of spec.split(',')) {
        const [name, slot] = entry.split('=').map((part) => part.trim());
        if (!name || !slot || Number.isNaN(Number(slot))) {
            throw new Error(`Invalid entry "${entry}" in MSL4048_DRIVES (expected name=slot, e.g. drive1=1)`);
        }
        drives[name] = Number(slot);
    }
    return drives;
}

function usage(): never {
    console.error(
        [
            'Usage: cli.js <on|off|status> [driveName]',
            '',
            'Connection settings come from environment variables:',
            '  MSL4048_HOST             library IP/hostname (required)',
            '  MSL4048_PASSWORD         password for MSL4048_PRIVILEGE_LEVEL (required)',
            '  MSL4048_PRIVILEGE_LEVEL  user | administrator | service (default: administrator)',
            '  MSL4048_DRIVES           comma list of name=slot, e.g. "drive1=1,drive2=2" (default: drive1=1)',
            '  MSL4048_LOCK_FILE        cross-process lock path (default: auto, per-host, under the OS temp dir)',
            '',
            'Examples:',
            '  cli.js on drive1',
            '  cli.js off drive1',
            '  cli.js status drive1',
            '  cli.js status            (reports every configured drive)',
        ].join('\n'),
    );
    process.exit(2);
}

async function main(): Promise<void> {
    const [action, driveName] = process.argv.slice(2);
    if (action !== 'on' && action !== 'off' && action !== 'status') usage();

    const host = process.env.MSL4048_HOST;
    if (!host) {
        console.error('MSL4048_HOST environment variable is required.');
        process.exit(2);
    }

    const password = process.env.MSL4048_PASSWORD;
    if (!password) {
        console.error('MSL4048_PASSWORD environment variable is required.');
        process.exit(2);
    }

    const privilegeLevel = (process.env.MSL4048_PRIVILEGE_LEVEL as PrivilegeLevel | undefined) ?? 'administrator';
    const drives = process.env.MSL4048_DRIVES ? parseDrives(process.env.MSL4048_DRIVES) : { drive1: 1 };

    const tape = new Drive({
        host,
        password,
        privilegeLevel,
        drives,
        lockFilePath: process.env.MSL4048_LOCK_FILE,
    });

    try {
        if (action === 'status') {
            const result = driveName ? await tape.status(driveName) : await tape.status();
            console.log(JSON.stringify(result, null, 4));
            return;
        }

        if (!driveName) {
            console.error(`Usage: cli.js ${action} <driveName>`);
            process.exit(2);
        }

        const info = action === 'on' ? await tape.poweron(driveName) : await tape.poweroff(driveName);
        console.log(JSON.stringify(info, null, 4));
    } finally {
        await tape.close();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
