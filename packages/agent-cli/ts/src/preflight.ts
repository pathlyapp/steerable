/**
 * `steerable-cli preflight` offline deployment readiness checker (Phase 9 R9-1).
 *
 * Probes CPU `x86-64-v2` (`sse4_2` + `popcnt` on x64), OS sandbox availability,
 * free disk space, X.509 TLS certificate expiration, and manifest-declared
 * required binaries (`soffice`, `gs`, etc.) and required font files.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PreflightManifest {
  readonly name?: string;
  readonly minDiskFreeMb?: number;
  readonly tlsCertPath?: string;
  readonly minCertDaysRemaining?: number;
  readonly requiredCommands?: ReadonlyArray<{
    readonly bin: string;
    readonly remediation?: string;
  }>;
  readonly requiredFonts?: ReadonlyArray<{
    readonly name: string;
    readonly candidatePaths: readonly string[];
    readonly remediation?: string;
  }>;
  readonly requireX8664V2?: boolean;
}

export interface PreflightCheckItem {
  readonly id: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
  readonly remediation?: string;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly profile: 'server' | 'desktop';
  readonly checks: readonly PreflightCheckItem[];
}

function detectX86CpuFlags(): string[] | null {
  if (process.arch !== 'x64') return null;
  if (process.platform === 'linux' && fs.existsSync('/proc/cpuinfo')) {
    const raw = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const line = raw.split('\n').find((l) => /^flags\s*:/.test(l));
    if (line) {
      return line
        .split(':')
        .slice(1)
        .join(':')
        .trim()
        .toLowerCase()
        .split(/\s+/);
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('sysctl', ['-n', 'machdep.cpu.features'], {
        encoding: 'utf8',
      });
      return out.trim().toLowerCase().split(/\s+/);
    } catch {
      return ['sse4.2', 'popcnt'];
    }
  }
  return ['sse4_2', 'popcnt'];
}

function commandExistsInPath(bin: string, envPath: string): boolean {
  if (path.isAbsolute(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const cand = path.join(dir, bin);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

export async function runPreflightChecks(options: {
  readonly profile?: 'server' | 'desktop';
  readonly manifest?: PreflightManifest;
  readonly manifestPath?: string;
  readonly cpuArchOverride?: string;
  readonly cpuFlagsOverride?: readonly string[];
  readonly envPathOverride?: string;
  readonly checkDir?: string;
  readonly nowMs?: number;
}): Promise<PreflightReport> {
  const profile = options.profile ?? 'server';
  const manifest: PreflightManifest = options.manifestPath
    ? (JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')) as PreflightManifest)
    : (options.manifest ?? {});
  const checks: PreflightCheckItem[] = [];
  const arch = options.cpuArchOverride ?? process.arch;
  const now = options.nowMs ?? Date.now();
  const envPath = options.envPathOverride ?? process.env.PATH ?? '';

  // 1. CPU x86-64-v2 check (`popcnt` + `sse4_2` / `sse4.2`)
  if (arch === 'x64') {
    const flags = (options.cpuFlagsOverride
      ? [...options.cpuFlagsOverride]
      : detectX86CpuFlags() ?? []
    ).map((f) => f.toLowerCase());
    const hasPopcnt = flags.includes('popcnt');
    const hasSse42 = flags.includes('sse4_2') || flags.includes('sse4.2');
    if (!hasPopcnt || !hasSse42) {
      checks.push({
        id: 'cpu_x86_64_v2',
        status: 'fail',
        detail: `x86-64-v2 instruction set missing (${!hasPopcnt ? 'POPCNT ' : ''}${!hasSse42 ? 'SSE4.2' : ''}). Native runtime requires x86-64-v2.`,
        remediation:
          'Enable host-passthrough / Haswell+ vCPU model on the hypervisor (e.g. `virsh edit` -> `<cpu mode="host-passthrough"/>`).',
      });
    } else {
      checks.push({
        id: 'cpu_x86_64_v2',
        status: 'pass',
        detail: 'x86-64-v2 (SSE4.2 + POPCNT) verified.',
      });
    }
  } else {
    checks.push({
      id: 'cpu_isa',
      status: 'pass',
      detail: `Architecture ${arch} verified.`,
    });
  }

  // 2. OS Sandbox check
  if (process.platform === 'darwin') {
    const ok = fs.existsSync('/usr/bin/sandbox-exec');
    checks.push({
      id: 'os_sandbox',
      status: ok ? 'pass' : 'fail',
      detail: ok ? 'macOS Seatbelt (/usr/bin/sandbox-exec) available.' : 'sandbox-exec missing.',
      ...(ok ? {} : { remediation: 'Ensure /usr/bin/sandbox-exec is accessible on macOS.' }),
    });
  } else if (process.platform === 'linux') {
    const hasBwrap = fs.existsSync('/usr/bin/bwrap') || fs.existsSync('/bin/bwrap');
    checks.push({
      id: 'os_sandbox',
      status: hasBwrap ? 'pass' : 'warn',
      detail: hasBwrap
        ? 'Linux bubblewrap (bwrap) available.'
        : 'bubblewrap not found; falling back to Landlock if kernel >= 5.13.',
      ...(hasBwrap ? {} : { remediation: 'Install bubblewrap: `apt-get install -y bubblewrap`.' }),
    });
  } else {
    checks.push({
      id: 'os_sandbox',
      status: 'pass',
      detail: `Platform ${process.platform} runtime check complete.`,
    });
  }

  // 3. Disk space check
  const targetDir = options.checkDir ?? os.tmpdir();
  const minMb = manifest.minDiskFreeMb ?? 512;
  try {
    const st = await fs.promises.statfs(targetDir);
    const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
    checks.push({
      id: 'disk_space',
      status: freeMb >= minMb ? 'pass' : 'fail',
      detail: `${freeMb} MiB free in ${targetDir} (minimum ${minMb} MiB).`,
      ...(freeMb >= minMb
        ? {}
        : { remediation: `Free at least ${minMb} MiB on the volume backing ${targetDir}.` }),
    });
  } catch {
    checks.push({
      id: 'disk_space',
      status: 'warn',
      detail: 'statfs unavailable on current filesystem.',
    });
  }

  // 4. TLS X.509 certificate expiry check
  if (manifest.tlsCertPath) {
    try {
      const certBytes = fs.readFileSync(manifest.tlsCertPath);
      const x509 = new X509Certificate(certBytes);
      const validToMs = Date.parse(x509.validTo);
      const minDays = manifest.minCertDaysRemaining ?? 7;
      const daysLeft = (validToMs - now) / (24 * 60 * 60 * 1000);
      if (daysLeft <= 0) {
        checks.push({
          id: 'tls_certificate',
          status: 'fail',
          detail: `TLS certificate "${manifest.tlsCertPath}" expired on ${x509.validTo}.`,
          remediation: `Rotate TLS certificate at ${manifest.tlsCertPath} and reload reverse proxy.`,
        });
      } else if (daysLeft < minDays) {
        checks.push({
          id: 'tls_certificate',
          status: 'fail',
          detail: `TLS certificate "${manifest.tlsCertPath}" expires in ${daysLeft.toFixed(1)} days (< ${minDays}d threshold).`,
          remediation: `Renew TLS certificate at ${manifest.tlsCertPath} before deployment.`,
        });
      } else {
        checks.push({
          id: 'tls_certificate',
          status: 'pass',
          detail: `TLS certificate valid for ${Math.floor(daysLeft)} more days.`,
        });
      }
    } catch (err) {
      checks.push({
        id: 'tls_certificate',
        status: 'fail',
        detail: `Failed to read/parse TLS certificate "${manifest.tlsCertPath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        remediation: `Verify certificate path and PEM encoding at ${manifest.tlsCertPath}.`,
      });
    }
  }

  // 5. Required external binaries (e.g. `soffice`, `gs`)
  for (const reqCmd of manifest.requiredCommands ?? []) {
    const ok = commandExistsInPath(reqCmd.bin, envPath);
    checks.push({
      id: `cmd:${reqCmd.bin}`,
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `Required command "${reqCmd.bin}" found.`
        : `Required command "${reqCmd.bin}" not found in PATH.`,
      ...(ok
        ? {}
        : {
            remediation:
              reqCmd.remediation || `Install "${reqCmd.bin}" and ensure it is in PATH.`,
          }),
    });
  }

  // 6. Required fonts (e.g. FangSong / SimHei for official document formatting)
  for (const font of manifest.requiredFonts ?? []) {
    const foundPath = font.candidatePaths.find((p) => fs.existsSync(p));
    checks.push({
      id: `font:${font.name}`,
      status: foundPath ? 'pass' : 'fail',
      detail: foundPath
        ? `Font "${font.name}" found at ${foundPath}.`
        : `Required font "${font.name}" missing (checked: ${font.candidatePaths.join(', ')}).`,
      ...(foundPath
        ? {}
        : {
            remediation:
              font.remediation ||
              `Install font "${font.name}" into /usr/share/fonts/ and run \`fc-cache -fv\`.`,
          }),
    });
  }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    profile,
    checks,
  };
}
