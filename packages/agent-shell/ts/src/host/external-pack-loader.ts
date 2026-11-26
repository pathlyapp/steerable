/**
 * Out-of-tree signed `.spack.tgz` pack bundler, Ed25519 signature verifier,
 * symlink guard, and `STEERABLE_PACK_DIRS` startup loader (Phase 9 R6).
 *
 * Fail-closed contract (`T-FDE-02` & `T-FDE-03`):
 * - Any symlink inside a pack archive/directory is rejected.
 * - Any file SHA-256 mismatch against `manifest.sig.json` is rejected.
 * - When `STEERABLE_PACK_PUBLIC_KEY` (or `publicKeyHex`) is set, missing or invalid
 *   Ed25519 signatures are rejected.
 * - Incompatible `steerableApiRange` is rejected.
 * - Startup integrity failures surface exit code `78` (`EX_CONFIG`).
 */
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ScenarioPack } from '@steerable/pack-sdk';

export const EXIT_PACK_INTEGRITY_FAILED = 78;

export interface SignedPackManifest {
  readonly formatVersion: 1;
  readonly packId: string;
  readonly version: string;
  readonly steerableApiRange: string;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
  readonly signatureHex?: string;
}

export class ExternalPackIntegrityError extends Error {
  readonly exitCode = EXIT_PACK_INTEGRITY_FAILED;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExternalPackIntegrityError';
    this.code = code;
  }
}

export function generatePackSigningKeypair(): {
  readonly publicKeyDerHex: string;
  readonly privateKeyDerHex: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyDerHex: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKeyDerHex: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

function canonicalManifestPayload(manifest: Omit<SignedPackManifest, 'signatureHex'>): string {
  const sortedFiles = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify({
    formatVersion: manifest.formatVersion,
    packId: manifest.packId,
    version: manifest.version,
    steerableApiRange: manifest.steerableApiRange,
    entry: manifest.entry,
    files: sortedFiles,
  });
}

function scanDirectoryNoSymlinks(
  rootDir: string,
  relPrefix = '',
): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'manifest.sig.json') {
      continue;
    }
    const full = path.join(rootDir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const lstat = fs.lstatSync(full);
    if (lstat.isSymbolicLink()) {
      throw new ExternalPackIntegrityError(
        'pack_symlink_forbidden',
        `Symlink "${rel}" is forbidden inside a signed scenario pack.`,
      );
    }
    if (lstat.isDirectory()) {
      Object.assign(files, scanDirectoryNoSymlinks(full, rel));
    } else if (lstat.isFile()) {
      const bytes = fs.readFileSync(full);
      files[rel] = createHash('sha256').update(bytes).digest('hex');
    }
  }
  return files;
}

export function satisfiesSimpleApiRange(hostVersion: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*') return true;
  const parseSemver = (v: string): [number, number, number] | null => {
    const m = v.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const hv = parseSemver(hostVersion);
  if (!hv) return false;
  const cmp = (a: [number, number, number], b: [number, number, number]): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  if (trimmed.startsWith('^')) {
    const rv = parseSemver(trimmed.slice(1));
    if (!rv) return false;
    if (rv[0] === 0) {
      return hv[0] === 0 && hv[1] === rv[1] && hv[2] >= rv[2];
    }
    return hv[0] === rv[0] && cmp(hv, rv) >= 0;
  }
  if (trimmed.startsWith('>=')) {
    const rv = parseSemver(trimmed.slice(2));
    return rv ? cmp(hv, rv) >= 0 : false;
  }
  const exact = parseSemver(trimmed);
  return exact ? cmp(hv, exact) === 0 : false;
}

export function bundleSignedPack(options: {
  readonly packDir: string;
  readonly outFile: string;
  readonly privateKeyDerHex?: string;
}): SignedPackManifest {
  const pkgPath = path.join(options.packDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new ExternalPackIntegrityError(
      'missing_package_json',
      `Pack directory "${options.packDir}" is missing package.json`,
    );
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    name?: string;
    version?: string;
    main?: string;
    exports?: Record<string, unknown> | string;
    steerablePack?: {
      id?: string;
      steerableApiRange?: string;
      entry?: string;
    };
  };

  const packId = pkg.steerablePack?.id || pkg.name || path.basename(options.packDir);
  const version = pkg.version || '0.1.0';
  const steerableApiRange = pkg.steerablePack?.steerableApiRange || '^0.12.0';
  const entry = pkg.steerablePack?.entry || pkg.main || 'dist/index.js';

  const files = scanDirectoryNoSymlinks(options.packDir);
  if (!files[entry]) {
    throw new ExternalPackIntegrityError(
      'missing_pack_entry',
      `Pack entry "${entry}" was not found in "${options.packDir}" (build the pack before bundling).`,
    );
  }

  const unsigned: Omit<SignedPackManifest, 'signatureHex'> = {
    formatVersion: 1,
    packId,
    version,
    steerableApiRange,
    entry,
    files,
  };

  let signatureHex: string | undefined;
  if (options.privateKeyDerHex) {
    const privKey = createPrivateKey({
      key: Buffer.from(options.privateKeyDerHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    const payloadBuf = Buffer.from(canonicalManifestPayload(unsigned), 'utf8');
    signatureHex = sign(null, payloadBuf, privKey).toString('hex');
  }

  const manifest: SignedPackManifest = {
    ...unsigned,
    ...(signatureHex ? { signatureHex } : {}),
  };

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spack-bundle-'));
  try {
    for (const rel of Object.keys(files)) {
      const src = path.join(options.packDir, rel);
      const dst = path.join(stageDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    fs.writeFileSync(
      path.join(stageDir, 'manifest.sig.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    fs.mkdirSync(path.dirname(path.resolve(options.outFile)), { recursive: true });
    execFileSync('tar', ['-czf', path.resolve(options.outFile), '-C', stageDir, '.']);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  return manifest;
}

export function verifyUnpackedPackDirectory(options: {
  readonly dir: string;
  readonly publicKeyDerHex?: string;
  readonly hostVersion?: string;
}): SignedPackManifest {
  const sigPath = path.join(options.dir, 'manifest.sig.json');
  if (!fs.existsSync(sigPath)) {
    throw new ExternalPackIntegrityError(
      'missing_manifest_sig',
      `External pack "${options.dir}" is missing manifest.sig.json`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(sigPath, 'utf8')) as SignedPackManifest;

  if (options.hostVersion && !satisfiesSimpleApiRange(options.hostVersion, manifest.steerableApiRange)) {
    throw new ExternalPackIntegrityError(
      'api_range_mismatch',
      `Pack "${manifest.packId}" requires steerableApiRange "${manifest.steerableApiRange}", incompatible with host "${options.hostVersion}"`,
    );
  }

  if (options.publicKeyDerHex) {
    if (!manifest.signatureHex) {
      throw new ExternalPackIntegrityError(
        'missing_signature',
        `Pack "${manifest.packId}" is unsigned, but STEERABLE_PACK_PUBLIC_KEY requires Ed25519 signature verification`,
      );
    }
    const pubKey = createPublicKey({
      key: Buffer.from(options.publicKeyDerHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    const payloadBuf = Buffer.from(canonicalManifestPayload(manifest), 'utf8');
    const ok = verify(
      null,
      payloadBuf,
      pubKey,
      Buffer.from(manifest.signatureHex, 'hex'),
    );
    if (!ok) {
      throw new ExternalPackIntegrityError(
        'invalid_signature',
        `Ed25519 signature verification failed for pack "${manifest.packId}"`,
      );
    }
  }

  // Scan actual unpacked files (enforces zero symlinks + exact file set + exact SHA-256!)
  const actualFiles = scanDirectoryNoSymlinks(options.dir);
  const expectedKeys = Object.keys(manifest.files).sort();
  const actualKeys = Object.keys(actualFiles).sort();
  if (expectedKeys.join('\n') !== actualKeys.join('\n')) {
    throw new ExternalPackIntegrityError(
      'file_inventory_mismatch',
      `Pack "${manifest.packId}" file list differs from signed manifest`,
    );
  }
  for (const rel of expectedKeys) {
    if (actualFiles[rel] !== manifest.files[rel]) {
      throw new ExternalPackIntegrityError(
        'file_hash_mismatch',
        `File "${rel}" in pack "${manifest.packId}" failed SHA-256 integrity check`,
      );
    }
  }

  return manifest;
}

export async function loadVerifiedExternalPacks(options: {
  readonly packPaths: readonly string[];
  readonly publicKeyDerHex?: string;
  readonly hostVersion?: string;
  readonly extractParentDir?: string;
}): Promise<{
  readonly packs: ScenarioPack[];
  readonly cleanup: () => void;
}> {
  const tempDirs: string[] = [];
  const packs: ScenarioPack[] = [];

  try {
    for (const rawTarget of options.packPaths) {
      const target = rawTarget.trim();
      if (!target) continue;
      if (!fs.existsSync(target)) {
        throw new ExternalPackIntegrityError(
          'pack_not_found',
          `External pack path does not exist: "${target}"`,
        );
      }

      let mountDir = target;
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) {
        throw new ExternalPackIntegrityError(
          'pack_symlink_forbidden',
          `External pack path "${target}" must not be a symlink`,
        );
      }
      if (st.isFile() && (target.endsWith('.spack.tgz') || target.endsWith('.tgz'))) {
        // Pre-scan tar entries for symlinks or path traversal (`..`) before extracting
        const listing = execFileSync('tar', ['-tvzf', target], { encoding: 'utf8' });
        for (const line of listing.split('\n')) {
          if (!line.trim()) continue;
          if (line.startsWith('l') || line.includes(' -> ') || /(?:^|\/)\.\.(?:\/|$)/.test(line)) {
            throw new ExternalPackIntegrityError(
              'pack_symlink_or_traversal',
              `Archive "${target}" contains forbidden symlink or path traversal entry: ${line}`,
            );
          }
        }
        mountDir = fs.mkdtempSync(
          path.join(options.extractParentDir ?? os.tmpdir(), 'spack-mount-'),
        );
        tempDirs.push(mountDir);
        execFileSync('tar', ['-xzf', target, '-C', mountDir]);
      }

      const manifest = verifyUnpackedPackDirectory({
        dir: mountDir,
        publicKeyDerHex: options.publicKeyDerHex,
        hostVersion: options.hostVersion,
      });

      const entryPath = path.join(mountDir, manifest.entry);
      const mod = (await import(pathToFileURL(entryPath).href)) as {
        default?: ScenarioPack;
        pack?: ScenarioPack;
      };
      const loaded = mod.default ?? mod.pack;
      if (!loaded || typeof loaded.id !== 'string') {
        throw new ExternalPackIntegrityError(
          'invalid_pack_export',
          `Pack "${manifest.packId}" entry "${manifest.entry}" did not export a valid ScenarioPack`,
        );
      }
      packs.push(loaded);
    }

    return {
      packs,
      cleanup: () => {
        for (const d of tempDirs) {
          fs.rmSync(d, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    throw err;
  }
}
