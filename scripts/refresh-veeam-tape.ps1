<#
.SYNOPSIS
    Tells Veeam Backup & Replication the tape drive is back online after
    this toolkit powers it on.

.DESCRIPTION
    Power-cycling the drive makes it disappear and reappear from Windows'
    (and Veeam's) point of view, same as unplugging/replugging it. Veeam
    only re-detects that via a rescan, and the Veeam Tape Access Service -
    the service that actually talks to the hardware - is commonly reported
    to hold a stale device handle from before the drive went away, so a
    rescan alone doesn't always pick it back up. This restarts that
    service, then rescans the tape server(s), which is the standard fix
    reported for a tape library/drive stuck showing offline.

    A rescan just polls current drive/slot state (a few seconds, no tape
    loaded/read) - it is not the same as an Inventory job, which is the
    slow operation that actually reads tape media; this script never runs
    one.

.PARAMETER TapeServerName
    Name of a specific Veeam tape server to rescan. Omit to rescan every
    tape server known to this Veeam Backup & Replication install.

.NOTES
    Run this ON the machine that IS the tape server (the one the library
    is attached to) and that has the Veeam Backup & Replication
    console/PowerShell module installed.

    Based on Veeam's public PowerShell reference and community-reported
    fixes for this exact "drive went offline and back" scenario - not
    verified against a live Veeam environment the way the drive power
    control itself was verified against the real MSL4048. Run it manually
    once and confirm the drive shows back online in the Veeam console
    before relying on it unattended from tape-power.bat.
#>

param(
    [string]$TapeServerName
)

$ErrorActionPreference = 'Stop'

try {
    Import-Module Veeam.Backup.PowerShell -ErrorAction Stop
} catch {
    # Older Veeam versions expose these cmdlets via a PSSnapin instead.
    Add-PSSnapin VeeamPSSnapIn -ErrorAction SilentlyContinue
}

Write-Host "Restarting Veeam Tape Access Service..."
Restart-Service -Name 'VeeamTapeSvc' -Force
Start-Sleep -Seconds 15

Write-Host "Rescanning tape server(s)..."
$tapeServers = if ($TapeServerName) {
    Get-VBRTapeServer -Name $TapeServerName
} else {
    Get-VBRTapeServer
}

if (-not $tapeServers) {
    throw "No Veeam tape server found$(if ($TapeServerName) { " matching name '$TapeServerName'" })."
}

$tapeServers | Rescan-VBREntity -Wait

Write-Host "Tape server rescan complete."
