/**
 * `steerable-cli preflight` offline deployment readiness checker (Phase 9 R9-1).
 *
 * Probes CPU `x86-64-v2` (`sse4_2` + `popcnt` on x64), OS sandbox availability,
 * free disk space, X.509 TLS certificate expiration, and manifest-declared
 * required binaries (`soffice`, `gs`, etc.) and required font files.
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DEFAULT_PRODUCTION_PUBKEY_HEX =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const BUILTIN_TEST_PUBKEY_HEX =
  '823a0180dd445bb17da134192431fe2c6a9c0281487be99112cfd3909c3af842';

function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJcs(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJcs(obj[k])}`).join(',')}}`;
}

function parseDateBoundaryMs(raw: string, endOfDay: boolean): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    const ms = Date.parse(`${raw.trim()}T${endOfDay ? '23:59:59.999Z' : '00:00:00.000Z'}`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export interface PreflightManifest {
  readonly name?: string;
  readonly minDiskFreeMb?: number;
  readonly tlsCertPath?: string;
  readonly minCertDaysRemaining?: number;
  readonly requireLicense?: boolean;
  readonly licenseFilePath?: string;
  readonly licenseStateDir?: string;
  readonly expectedProduct?: string;
  readonly licensePubkeyHex?: string;
  readonly minLicenseDaysRemaining?: number;
  readonly allowTestLicenseKeys?: boolean;
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
  readonly requireLicense?: boolean;
  readonly licenseFilePath?: string;
  readonly licenseStateDir?: string;
  readonly expectedProduct?: string;
  readonly licensePubkeyHex?: string;
  readonly allowTestLicenseKeys?: boolean;
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

  // 7. Commercial license file check (active only when STEERABLE_LICENSE_FILE is set or --require-license / manifest.requireLicense)
  const resolvedLicensePath =
    options.licenseFilePath ?? manifest.licenseFilePath ?? process.env.STEERABLE_LICENSE_FILE;
  const shouldCheckLicense =
    Boolean(options.requireLicense) ||
    Boolean(manifest.requireLicense) ||
    Boolean(resolvedLicensePath && resolvedLicensePath.trim().length > 0);

  if (shouldCheckLicense) {
    if (!resolvedLicensePath || !fs.existsSync(resolvedLicensePath)) {
      checks.push({
        id: 'license',
        status: 'fail',
        detail: resolvedLicensePath
          ? `License file not found at "${resolvedLicensePath}".`
          : 'Commercial license required (--require-license), but STEERABLE_LICENSE_FILE is not set.',
        remediation:
          'Mount a valid `.lic` file and set STEERABLE_LICENSE_FILE=/var/lib/steerable/license/<product>.lic.',
      });
    } else {
      try {
        const rawText = fs.readFileSync(resolvedLicensePath, 'utf8');
        const envelope = JSON.parse(rawText) as {
          payload?: Record<string, unknown>;
          keyEnvironment?: string;
          signature?: string;
        };
        const payload = envelope.payload;
        if (
          !payload ||
          typeof payload !== 'object' ||
          typeof envelope.signature !== 'string' ||
          typeof payload.licenseId !== 'string' ||
          typeof payload.product !== 'string' ||
          typeof payload.notBefore !== 'string' ||
          typeof payload.notAfter !== 'string'
        ) {
          checks.push({
            id: 'license',
            status: 'fail',
            detail: `Malformed license envelope in "${resolvedLicensePath}".`,
            remediation: 'Replace the corrupted `.lic` file with a freshly issued signed license.',
          });
        } else {
          const allowTest =
            options.allowTestLicenseKeys ??
            manifest.allowTestLicenseKeys ??
            process.env.STEERABLE_LICENSE_ALLOW_TEST_KEYS === '1';
          if (envelope.keyEnvironment === 'test' && !allowTest) {
            checks.push({
              id: 'license',
              status: 'fail',
              detail: `License "${payload.licenseId}" uses test keyEnvironment, which is forbidden in production.`,
              remediation: 'Re-issue the license with the offline production signing key.',
            });
          } else {
            const pubHex = (
              options.licensePubkeyHex ??
              manifest.licensePubkeyHex ??
              process.env.STEERABLE_LICENSE_PUBKEY_HEX ??
              (envelope.keyEnvironment === 'test'
                ? BUILTIN_TEST_PUBKEY_HEX
                : DEFAULT_PRODUCTION_PUBKEY_HEX)
            ).trim();
            const rawPub = Buffer.from(pubHex, 'hex');
            const spki = createPublicKey({
              key: Buffer.concat([ED25519_SPKI_PREFIX, rawPub]),
              format: 'der',
              type: 'spki',
            });
            const canonicalBytes = Buffer.from(canonicalizeJcs(payload), 'utf8');
            const sigBytes = Buffer.from(envelope.signature.trim(), 'base64url');
            const sigValid =
              rawPub.length === 32 &&
              sigBytes.length === 64 &&
              cryptoVerify(null, canonicalBytes, spki, sigBytes);

            const expectedProd =
              options.expectedProduct ??
              manifest.expectedProduct ??
              process.env.KEEL_LICENSE_PRODUCT;
            const stateDir =
              options.licenseStateDir ??
              manifest.licenseStateDir ??
              process.env.STEERABLE_LICENSE_STATE_DIR ??
              path.dirname(resolvedLicensePath);
            const deployIdFile = path.join(stateDir, '.deployment_id');
            const persistedDeployId = fs.existsSync(deployIdFile)
              ? fs.readFileSync(deployIdFile, 'utf8').trim()
              : null;
            const boundDeployId =
              typeof payload.deploymentId === 'string' && payload.deploymentId.trim()
                ? payload.deploymentId.trim()
                : null;

            const notBeforeMs = parseDateBoundaryMs(payload.notBefore, false);
            const notAfterMs = parseDateBoundaryMs(payload.notAfter, true);
            const graceDays =
              typeof payload.graceDays === 'number' && payload.graceDays >= 0
                ? payload.graceDays
                : 15;
            const warnDays =
              manifest.minLicenseDaysRemaining ??
              (typeof payload.expiringNoticeDays === 'number' ? payload.expiringNoticeDays : 30);

            if (!sigValid) {
              checks.push({
                id: 'license',
                status: 'fail',
                detail: `Ed25519 signature verification failed for license "${payload.licenseId}".`,
                remediation: 'Ensure the `.lic` file was not modified and matches this binary public key.',
              });
            } else if (expectedProd && payload.product !== expectedProd) {
              checks.push({
                id: 'license',
                status: 'fail',
                detail: `License product mismatch: expected "${expectedProd}", got "${payload.product}".`,
                remediation: `Issue a license bound to product "${expectedProd}".`,
              });
            } else if (boundDeployId && persistedDeployId && boundDeployId !== persistedDeployId) {
              checks.push({
                id: 'license',
                status: 'fail',
                detail: `License deploymentId mismatch: license bound to "${boundDeployId}", host has "${persistedDeployId}".`,
                remediation: `Request a license bound to deploymentId "${persistedDeployId}".`,
              });
            } else if (notBeforeMs === null || notAfterMs === null) {
              checks.push({
                id: 'license',
                status: 'fail',
                detail: `Invalid notBefore/notAfter date format in license "${payload.licenseId}".`,
              });
            } else if (now < notBeforeMs) {
              checks.push({
                id: 'license',
                status: 'fail',
                detail: `License "${payload.licenseId}" is not yet valid (notBefore=${payload.notBefore}); verify host NTP clock.`,
                remediation: 'Synchronize host system clock via chrony/ntpd or check license start date.',
              });
            } else {
              const daysRemaining = Math.ceil((notAfterMs - now) / (24 * 60 * 60 * 1000));
              const graceEndMs = notAfterMs + graceDays * 24 * 60 * 60 * 1000;
              const graceRemaining = Math.ceil((graceEndMs - now) / (24 * 60 * 60 * 1000));
              if (now > graceEndMs) {
                checks.push({
                  id: 'license',
                  status: 'fail',
                  detail: `License "${payload.licenseId}" expired (grace period ended on ${new Date(graceEndMs).toISOString().slice(0, 10)}).`,
                  remediation: 'Renew the commercial `.lic` file before starting production inference.',
                });
              } else if (now > notAfterMs) {
                checks.push({
                  id: 'license',
                  status: 'warn',
                  detail: `License "${payload.licenseId}" is in grace period (${graceRemaining} grace days left).`,
                  remediation: 'Upload a renewed `.lic` file as soon as possible.',
                });
              } else if (daysRemaining <= warnDays) {
                checks.push({
                  id: 'license',
                  status: 'warn',
                  detail: `License "${payload.licenseId}" expires in ${daysRemaining} days (notAfter=${payload.notAfter}).`,
                  remediation: 'Contact vendor to renew the license before expiration.',
                });
              } else {
                checks.push({
                  id: 'license',
                  status: 'pass',
                  detail: `License "${payload.licenseId}" (${payload.product}) verified; ${daysRemaining} days remaining.`,
                });
              }
            }
          }
        }
      } catch (err) {
        checks.push({
          id: 'license',
          status: 'fail',
          detail: `Failed to verify license "${resolvedLicensePath}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          remediation: 'Verify `.lic` JSON syntax and file permissions.',
        });
      }
    }
  }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    profile,
    checks,
  };
}
