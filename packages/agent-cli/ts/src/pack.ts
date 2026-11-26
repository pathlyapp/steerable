/**
 * `steerable-cli pack init | test | bundle` (Phase 9 R6).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ExternalPackIntegrityError,
  bundleSignedPack,
} from '@steerable/agent-shell/host/external-pack-loader';
import { validatePackStaticGuards } from '@steerable/pack-testkit';

export interface PackCommandOptions {
  readonly subcommand: string;
  readonly targetDir: string;
  readonly packId?: string;
  readonly outFile?: string;
  readonly signingKeyEnv?: string;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export async function runPackCliCommand(options: PackCommandOptions): Promise<number> {
  const { subcommand, stdout, stderr } = options;
  const dir = path.resolve(options.targetDir || '.');

  if (subcommand === 'init') {
    const id = (options.packId || path.basename(dir))
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });

    const pkgJson = {
      name: `@custom/pack-${id}`,
      version: '0.1.0',
      type: 'module',
      main: 'dist/index.js',
      steerablePack: {
        id,
        steerableApiRange: '^0.12.0',
        entry: 'dist/index.js',
      },
      dependencies: {
        '@steerable/pack-sdk': '^0.12.8',
      },
      devDependencies: {
        '@steerable/pack-testkit': '^0.12.8',
      },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`);

    const srcIndex = `import type { ScenarioPack } from '@steerable/pack-sdk';

export const pack: ScenarioPack = {
  id: '${id}',
  main: {
    tools: [
      {
        name: '${id.replace(/-/g, '_')}_ping',
        description: 'Sample read-only health check tool',
        mode: 'read',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ status: 'ok', packId: '${id}' }),
      },
    ],
  },
};

export default pack;
`;
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), srcIndex);

    // Emit ready-to-bundle JS entry as well so `pack test` & `pack bundle` work out of the box
    const distIndex = `export const pack = {
  id: '${id}',
  main: {
    tools: [
      {
        name: '${id.replace(/-/g, '_')}_ping',
        description: 'Sample read-only health check tool',
        mode: 'read',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ status: 'ok', packId: '${id}' }),
      },
    ],
  },
};
export default pack;
`;
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), distIndex);

    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: true, packId: id, dir })}\n`);
    } else {
      stdout.write(`Initialized scenario pack "${id}" in ${dir}\n`);
    }
    return 0;
  }

  if (subcommand === 'test') {
    const report = validatePackStaticGuards(dir);
    if (options.json) {
      stdout.write(`${JSON.stringify(report)}\n`);
    } else if (report.ok) {
      stdout.write(`pack test OK (${report.checkedFiles} source file(s) passed AST guards)\n`);
    } else {
      for (const v of report.violations) {
        stderr.write(`[${v.rule}] ${v.file}:${v.line}: ${v.message}\n`);
      }
    }
    return report.ok ? 0 : 1;
  }

  if (subcommand === 'bundle') {
    const outFile = options.outFile || path.join(dir, `${path.basename(dir)}.spack.tgz`);
    const envMap = options.env ?? process.env;
    const keyVar = options.signingKeyEnv || 'STEERABLE_PACK_SIGNING_KEY';
    const privHex = envMap[keyVar]?.trim() || undefined;

    try {
      const guardReport = validatePackStaticGuards(dir);
      if (!guardReport.ok) {
        for (const v of guardReport.violations) {
          stderr.write(`[${v.rule}] ${v.file}:${v.line}: ${v.message}\n`);
        }
        return 1;
      }
      const manifest = bundleSignedPack({
        packDir: dir,
        outFile,
        privateKeyDerHex: privHex,
      });
      if (options.json) {
        stdout.write(
          `${JSON.stringify({
            ok: true,
            outFile: path.resolve(outFile),
            packId: manifest.packId,
            signed: Boolean(manifest.signatureHex),
          })}\n`,
        );
      } else {
        stdout.write(
          `Bundled ${manifest.packId}@${manifest.version} -> ${path.resolve(outFile)} (${
            manifest.signatureHex ? 'signed Ed25519' : 'unsigned'
          })\n`,
        );
      }
      return 0;
    } catch (err) {
      if (err instanceof ExternalPackIntegrityError) {
        stderr.write(`${err.code}: ${err.message}\n`);
        return err.exitCode;
      }
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  stderr.write(`unknown pack subcommand: ${subcommand} (expected init | test | bundle)\n`);
  return 2;
}
