import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_PACK_INTEGRITY_FAILED,
  ExternalPackIntegrityError,
  generatePackSigningKeypair,
  loadVerifiedExternalPacks,
} from '@steerable/agent-shell/host/external-pack-loader';
import { createPackTestHost } from '@steerable/pack-testkit';
import { createCli } from '../src/cli.js';
import { runPreflightChecks } from '../src/preflight.js';
import { exportDiagBundle } from '../src/diag-bundle.js';
import { runSiteEvalSuite, type SiteEvalCase } from '../src/site-eval.js';

function captureStreams() {
  let out = '';
  let err = '';
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (c) => {
    out += String(c);
  });
  stderr.on('data', (c) => {
    err += String(c);
  });
  return { stdout, stderr, readOut: () => out, readErr: () => err };
}

describe('Phase 9 S5: Out-of-tree Signed Packs, PackTestHost, Preflight, Diag-Bundle & Site-Eval', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerable-s5-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('T-FDE-01, T-FDE-02 & T-FDE-03: pack init -> pack test -> pack bundle with Ed25519 signature mounts cleanly and rejects 1-byte tamper, symlinks, or API range mismatch with exit code 78', async () => {
    const packDir = path.join(tempDir, 'my-field-pack');
    const archivePath = path.join(tempDir, 'my-field-pack.spack.tgz');
    const { publicKeyDerHex, privateKeyDerHex } = generatePackSigningKeypair();

    // 1. steerable-cli pack init
    const s1 = captureStreams();
    const initCode = await createCli({
      argv: ['pack', 'init', packDir, '--id', 'field-ops', '--json'],
      stdout: s1.stdout,
      stderr: s1.stderr,
    });
    expect(initCode).toBe(0);

    // 2. steerable-cli pack test
    const s2 = captureStreams();
    const testCode = await createCli({
      argv: ['pack', 'test', packDir, '--json'],
      stdout: s2.stdout,
      stderr: s2.stderr,
    });
    expect(testCode).toBe(0);

    // 3. steerable-cli pack bundle (signed)
    const s3 = captureStreams();
    const bundleCode = await createCli({
      argv: ['pack', 'bundle', packDir, '--out', archivePath, '--json'],
      env: { ...process.env, STEERABLE_PACK_SIGNING_KEY: privateKeyDerHex },
      stdout: s3.stdout,
      stderr: s3.stderr,
    });
    expect(bundleCode).toBe(0);
    expect(fs.existsSync(archivePath)).toBe(true);

    // 4. Mount and execute via loadVerifiedExternalPacks + createPackTestHost
    const mounted = await loadVerifiedExternalPacks({
      packPaths: [archivePath],
      publicKeyDerHex,
      hostVersion: '0.12.8',
    });
    expect(mounted.packs).toHaveLength(1);
    const testHost = createPackTestHost({ pack: mounted.packs[0] });
    const pingRes = await testHost.callTool('field_ops_ping', {});
    expect(pingRes.ok).toBe(true);
    expect(pingRes.result).toEqual({ status: 'ok', packId: 'field-ops' });
    mounted.cleanup();

    // 5. T-FDE-02:Incompatible steerableApiRange -> exitCode 78
    await expect(
      loadVerifiedExternalPacks({
        packPaths: [archivePath],
        publicKeyDerHex,
        hostVersion: '2.0.0',
      }),
    ).rejects.toMatchObject({
      code: 'api_range_mismatch',
      exitCode: EXIT_PACK_INTEGRITY_FAILED,
    });

    // 6. T-FDE-02: 1-byte tamper inside unpacked pack -> exitCode 78!
    const unpackedDir = path.join(tempDir, 'tampered-unpack');
    fs.mkdirSync(unpackedDir, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', unpackedDir]);
    fs.appendFileSync(path.join(unpackedDir, 'dist', 'index.js'), '\n// 1-byte tamper');

    await expect(
      loadVerifiedExternalPacks({
        packPaths: [unpackedDir],
        publicKeyDerHex,
        hostVersion: '0.12.8',
      }),
    ).rejects.toMatchObject({
      code: 'file_hash_mismatch',
      exitCode: EXIT_PACK_INTEGRITY_FAILED,
    });

    // 7. T-FDE-03: Symlink inside pack directory -> exitCode 78!
    fs.symlinkSync('/etc/hosts', path.join(packDir, 'dist', 'sneaky-link'));
    const sSym = captureStreams();
    const symCode = await createCli({
      argv: ['pack', 'bundle', packDir, '--out', path.join(tempDir, 'bad.spack.tgz')],
      stdout: sSym.stdout,
      stderr: sSym.stderr,
    });
    expect(symCode).toBe(EXIT_PACK_INTEGRITY_FAILED);
  });

  it('T-FDE-04: preflight detects missing POPCNT on x64, expired TLS certificate, and missing required binaries/fonts with remediation guidance', async () => {
    // Generate a self-signed X.509 cert valid from 2020 to 2021 (expired relative to nowMs)
    const certFile = path.join(tempDir, 'test-tls-cert.crt');
    const keyFile = path.join(tempDir, 'test-tls-priv.bin');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=internal.local',
    ]);
    const certStatNowPlus10d = Date.now() + 10 * 24 * 60 * 60 * 1000;

    const report = await runPreflightChecks({
      profile: 'server',
      cpuArchOverride: 'x64',
      cpuFlagsOverride: ['sse2', 'sse4_2'], // missing POPCNT!
      envPathOverride: tempDir, // empty PATH -> missing soffice
      nowMs: certStatNowPlus10d,
      manifest: {
        tlsCertPath: certFile,
        requiredCommands: [
          { bin: 'soffice', remediation: 'apt-get install -y libreoffice-writer' },
        ],
        requiredFonts: [
          {
            name: 'FangSong_GB2312',
            candidatePaths: [path.join(tempDir, 'nonexistent-font.ttf')],
            remediation: 'Copy FangSong_GB2312.ttf to /usr/share/fonts/custom/',
          },
        ],
      },
    });

    expect(report.ok).toBe(false);
    const failedIds = report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    expect(failedIds).toContain('cpu_x86_64_v2');
    expect(failedIds).toContain('tls_certificate');
    expect(failedIds).toContain('cmd:soffice');
    expect(failedIds).toContain('font:FangSong_GB2312');
    for (const f of report.checks.filter((c) => c.status === 'fail')) {
      expect(f.remediation).toBeTruthy();
    }
  });

  it('T-FDE-05: diag-bundle scrubs secrets, excludes memory/, and replaces prose with [REDACTED len=... sha256=...] while keeping LoopEvent & error skeletons', () => {
    const fakeDataDir = path.join(tempDir, 'host-data');
    fs.mkdirSync(path.join(fakeDataDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(fakeDataDir, 'memory', 'user'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeDataDir, 'memory', 'user', 'MEMORY.md'),
      'TOP_SECRET_PERSONAL_MEMORY_NOTE',
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeDataDir, 'credential-master-key.bin'),
      'RAW_MASTER_KEY_BYTES',
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeDataDir, 'logs', 'host.log'),
      '2026-11-26 ERROR upstream Authorization: Bearer sk-live-secret9876543210 failed with ECONNRESET\n',
      'utf8',
    );

    const outTgz = path.join(tempDir, 'diag-out.tgz');
    const sensitiveDocSentence = '关于园区管委会2026年度机密预算批复通知原文';
    const tenantCustomSecret = 'acme-erp-password-778899';

    const bundle = exportDiagBundle({
      dataDir: fakeDataDir,
      outFile: outTgz,
      extraSecrets: [tenantCustomSecret],
      chats: [
        {
          id: 'chat-fail-1',
          title: sensitiveDocSentence,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: `请核对红头文件：${sensitiveDocSentence} token=${tenantCustomSecret}`,
              metadata: {
                loopEvents: [{ kind: 'turn_failed', errorCode: 'outcome_unknown', durationMs: 412 }],
                executedActions: [
                  {
                    id: 'tc_1',
                    tool: 'dispatch_notice',
                    success: false,
                    effect: 'unknown',
                    outcomeUnknown: true,
                    errorCode: 'ETIMEDOUT',
                    durationMs: 15002,
                    arguments: { body: sensitiveDocSentence },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(bundle.redactContent).toBe(true);
    const verifyDir = path.join(tempDir, 'diag-unpack');
    fs.mkdirSync(verifyDir, { recursive: true });
    execFileSync('tar', ['-xzf', outTgz, '-C', verifyDir]);

    // Must NOT include memory/ or credential-master-key.bin
    expect(fs.existsSync(path.join(verifyDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(verifyDir, 'credential-master-key.bin'))).toBe(false);

    const allFilesText = [
      fs.readFileSync(path.join(verifyDir, 'environment.json'), 'utf8'),
      fs.readFileSync(path.join(verifyDir, 'logs', 'host.log'), 'utf8'),
      fs.readFileSync(path.join(verifyDir, 'chat-skeletons.json'), 'utf8'),
    ].join('\n');

    expect(allFilesText).not.toContain('TOP_SECRET_PERSONAL_MEMORY_NOTE');
    expect(allFilesText).not.toContain('RAW_MASTER_KEY_BYTES');
    expect(allFilesText).not.toContain('sk-live-secret9876543210');
    expect(allFilesText).not.toContain(tenantCustomSecret);
    expect(allFilesText).not.toContain(sensitiveDocSentence);

    // Skeleton metadata (tool name, ETIMEDOUT, outcome_unknown, [REDACTED len=...]) preserved!
    expect(allFilesText).toContain('[REDACTED len=');
    expect(allFilesText).toContain('dispatch_notice');
    expect(allFilesText).toContain('ETIMEDOUT');
    expect(allFilesText).toContain('outcome_unknown');
  });

  it('T-FDE-06: site-eval scores native tool_calls, XML pseudo-tool recovery, promised_action rescue, and recommends echoEmptyReasoningForToolCalls on HTTP 400', async () => {
    const cases: SiteEvalCase[] = [
      {
        id: 'c1-native',
        prompt: 'Query well depth',
        expectedTool: 'query_well',
        verifyToolRoundtrip: true,
        tools: [{ name: 'query_well', description: 'Query well', parameters: { type: 'object' } }],
      },
      {
        id: 'c2-pseudo-xml',
        prompt: 'List pending orders',
        expectedTool: 'list_orders',
        tools: [{ name: 'list_orders', description: 'List orders', parameters: { type: 'object' } }],
      },
      {
        id: 'c3-promised-rescue',
        prompt: 'Check ledger balance',
        expectedTool: 'check_ledger',
        tools: [{ name: 'check_ledger', description: 'Check ledger', parameters: { type: 'object' } }],
      },
    ];

    let c3Attempt = 0;
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[] }>;
      };
      const firstPrompt = req.messages[0]?.content ?? '';

      if (firstPrompt === 'Query well depth') {
        if (req.messages.length > 1) {
          // Simulate DeepSeek-R1 / vLLM HTTP 400 when assistant tool_call lacks reasoning_content!
          return new Response(
            JSON.stringify({
              error: { message: '400 Bad Request: assistant message missing reasoning_content field' },
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'tc1', function: { name: 'query_well', arguments: '{}' } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (firstPrompt === 'List pending orders') {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Sure!\n<function=list_orders>{"limit":10}</function>',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      // c3-promised-rescue: first round narrates promise without tool_call; second round emits tool_call!
      c3Attempt += 1;
      if (c3Attempt === 1) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '好的，我现在调用工具查询台账余额。' } }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'tc3', function: { name: 'check_ledger', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const reportPath = path.join(tempDir, 'site-eval-report.json');
    const report = await runSiteEvalSuite({
      model: 'private-qwen-32b',
      baseUrl: 'http://127.0.0.1:18080/v1',
      cases,
      outFile: reportPath,
      fetchImpl: mockFetch,
    });

    expect(report.totalCases).toBe(3);
    expect(report.passedCases).toBe(3);
    expect(report.toolHitRate).toBeCloseTo(1 / 3, 3);
    expect(report.pseudoToolRecoveries).toBe(1);
    expect(report.promisedActionRescues).toBe(1);
    expect(report.http400Count).toBe(1);
    expect(report.compatRecommendations).toEqual({
      echoEmptyReasoningForToolCalls: true,
    });
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it('T-LIC-07: preflight --require-license verifies Ed25519 JCS license, warns on expiring/grace, fails on bad signature or deploymentId mismatch, and diag-bundle redacts signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
    const rawPubHex = spkiDer.subarray(spkiDer.length - 32).toString('hex');

    const signLic = (payload: Record<string, unknown>, keyEnvironment = 'production') => {
      const canonical = JSON.stringify(
        Object.keys(payload)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = payload[k];
            return acc;
          }, {}),
      );
      const sig = cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url');
      return JSON.stringify({ payload, keyEnvironment, signature: sig }, null, 2);
    };

    // 0. Open-source default (no --require-license, no STEERABLE_LICENSE_FILE) omits license check
    const ossReport = await runPreflightChecks({
      profile: 'server',
      cpuArchOverride: 'arm64',
    });
    expect(ossReport.checks.find((c) => c.id === 'license')).toBeUndefined();

    // 1. Valid license passes preflight
    const stateDir = path.join(tempDir, 'lic-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.deployment_id'), 'dep-node-01\n', 'utf8');
    const validLicPath = path.join(stateDir, 'enterprise.lic');
    const nowMs = Date.parse('2026-11-26T12:00:00Z');
    fs.writeFileSync(
      validLicPath,
      signLic({
        customer: 'Acme Corp Secret Tenant',
        deploymentId: 'dep-node-01',
        expiringNoticeDays: 30,
        features: ['sso', 'audit'],
        graceDays: 15,
        issuedAt: '2026-11-01',
        licenseId: 'lic-2026-0001',
        maxConcurrentRuns: 10,
        maxUsers: 50,
        notAfter: '2027-06-01',
        notBefore: '2026-11-01',
        product: 'enterprise-suite',
        schemaVersion: 1,
      }),
      'utf8',
    );

    const passReport = await runPreflightChecks({
      profile: 'server',
      cpuArchOverride: 'arm64',
      requireLicense: true,
      licenseFilePath: validLicPath,
      licenseStateDir: stateDir,
      expectedProduct: 'enterprise-suite',
      licensePubkeyHex: rawPubHex,
      nowMs,
    });
    expect(passReport.ok).toBe(true);
    expect(passReport.checks.find((c) => c.id === 'license')?.status).toBe('pass');

    // 2. Expiring within 30 days -> warn (ok remains true)
    const expSoonMs = Date.parse('2027-05-15T12:00:00Z');
    const warnReport = await runPreflightChecks({
      profile: 'server',
      cpuArchOverride: 'arm64',
      requireLicense: true,
      licenseFilePath: validLicPath,
      licenseStateDir: stateDir,
      expectedProduct: 'enterprise-suite',
      licensePubkeyHex: rawPubHex,
      nowMs: expSoonMs,
    });
    expect(warnReport.ok).toBe(true);
    expect(warnReport.checks.find((c) => c.id === 'license')?.status).toBe('warn');

    // 3. DeploymentId mismatch -> fail
    fs.writeFileSync(path.join(stateDir, '.deployment_id'), 'dep-cloned-vm-99\n', 'utf8');
    const mismatchReport = await runPreflightChecks({
      profile: 'server',
      cpuArchOverride: 'arm64',
      requireLicense: true,
      licenseFilePath: validLicPath,
      licenseStateDir: stateDir,
      expectedProduct: 'enterprise-suite',
      licensePubkeyHex: rawPubHex,
      nowMs,
    });
    expect(mismatchReport.ok).toBe(false);
    expect(mismatchReport.checks.find((c) => c.id === 'license')?.detail).toContain(
      'deploymentId mismatch',
    );

    // 4. diag-bundle includes license-status.json with signature stripped & customer redacted
    const diagTgz = path.join(tempDir, 'lic-diag.tgz');
    const bundle = exportDiagBundle({
      dataDir: tempDir,
      outFile: diagTgz,
      licenseFilePath: validLicPath,
    });
    expect(bundle.includedFiles).toContain('license-status.json');
    const unpackLicDir = path.join(tempDir, 'lic-diag-unpack');
    fs.mkdirSync(unpackLicDir, { recursive: true });
    execFileSync('tar', ['-xzf', diagTgz, '-C', unpackLicDir]);
    const licJsonRaw = fs.readFileSync(path.join(unpackLicDir, 'license-status.json'), 'utf8');
    const licJson = JSON.parse(licJsonRaw) as Record<string, unknown>;
    expect(licJson.licenseId).toBe('lic-2026-0001');
    expect(licJson.product).toBe('enterprise-suite');
    expect(licJson.signature).toBeUndefined();
    expect(licJsonRaw).not.toContain('Acme Corp Secret Tenant');
    expect(String(licJson.customer)).toContain('[REDACTED len=');
  });
});
