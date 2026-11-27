import { afterEach, describe, expect, it } from 'vitest';
import {
  SecretRedactor,
  clearGlobalSecretsForTests,
  registerGlobalSecret,
} from '../../src/auth/credentials.js';
import {
  isProtectedHostEnvKey,
  registerProtectedEnvKeys,
  resetProtectedEnvKeysForTests,
  scrubToolSubprocessEnv,
} from '../../src/env-sanitizer.js';
import { LocalExecutor } from '../../src/local-executor.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const TEST_SECRET_KEYS = [
  'STEERABLE_CREDENTIAL_MASTER_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'TEAM_SERVER_INTERNAL_TOKEN',
  'TEAM_SERVER_BOOTSTRAP_TOKEN',
  'APP_INTERNAL_BEARER',
  'SHARED_MYSQL_URL',
  'CUSTOM_PACK_SECRET_TOKEN',
];

function setTestEnv(values: Record<string, string>): void {
  for (const key of TEST_SECRET_KEYS) {
    if (!(key in SAVED_ENV)) SAVED_ENV[key] = process.env[key];
  }
  for (const [k, v] of Object.entries(values)) {
    process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(SAVED_ENV)) delete SAVED_ENV[k];
  resetProtectedEnvKeysForTests();
  clearGlobalSecretsForTests();
});

describe('T-ENV-02: tool subprocess environment sanitizer', () => {
  it('strips protected host keys, suffixes, and custom prefixes while keeping explicit extraEnv', () => {
    const dispose = registerProtectedEnvKeys(['CUSTOM_PACK_']);
    const scrubbed = scrubToolSubprocessEnv(
      {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/user-a',
        STEERABLE_CREDENTIAL_MASTER_KEY: 'master-secret-key-value',
        DEEPSEEK_API_KEY: 'sk-deepseek-tenant-secret',
        TEAM_SERVER_INTERNAL_TOKEN: 'internal-rpc-secret',
        TEAM_SERVER_BOOTSTRAP_TOKEN: 'bootstrap-once-secret',
        APP_INTERNAL_BEARER: 'bearer-secret-999',
        SHARED_MYSQL_URL: 'mysql://team_user:mysql_super_secret@127.0.0.1:3306/teamdb',
        CUSTOM_PACK_SECRET_TOKEN: 'custom-pack-token-123',
      },
      {
        EXPLICIT_CALLER_VAR: 'allowed-explicit-value',
      },
    );

    expect(scrubbed.PATH).toBe('/usr/bin:/bin');
    expect(scrubbed.HOME).toBe('/tmp/user-a');
    expect(scrubbed.EXPLICIT_CALLER_VAR).toBe('allowed-explicit-value');
    expect(scrubbed.STEERABLE_CREDENTIAL_MASTER_KEY).toBeUndefined();
    expect(scrubbed.DEEPSEEK_API_KEY).toBeUndefined();
    expect(scrubbed.TEAM_SERVER_INTERNAL_TOKEN).toBeUndefined();
    expect(scrubbed.TEAM_SERVER_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(scrubbed.APP_INTERNAL_BEARER).toBeUndefined();
    expect(scrubbed.SHARED_MYSQL_URL).toBeUndefined();
    expect(scrubbed.CUSTOM_PACK_SECRET_TOKEN).toBeUndefined();

    // Scrubbed values (including URL password) are seeded into SecretRedactor
    const redactor = new SecretRedactor();
    expect(
      redactor.redactString(
        'leak sk-deepseek-tenant-secret and mysql_super_secret in error',
      ),
    ).toBe('leak [REDACTED:credential] and [REDACTED:credential] in error');

    dispose();
    expect(isProtectedHostEnvKey('CUSTOM_PACK_SECRET_TOKEN')).toBe(false);
  });

  it('prevents local_exec_shell and local_run_snippet from reading host secrets in process.env', async () => {
    setTestEnv({
      STEERABLE_CREDENTIAL_MASTER_KEY: 'master-key-xyz-987654',
      DEEPSEEK_API_KEY: 'sk-live-tenant-secret-key',
      TEAM_SERVER_INTERNAL_TOKEN: 'internal-token-secret-abc',
      SHARED_MYSQL_URL: 'mysql://root:db_pass_secret_42@127.0.0.1:3306/etown',
    });
    registerGlobalSecret('manual-registered-tenant-secret');

    const executor = new LocalExecutor();
    const shellRes = await executor.executeShell({
      command:
        process.platform === 'win32'
          ? 'Write-Output "$env:DEEPSEEK_API_KEY|$env:STEERABLE_CREDENTIAL_MASTER_KEY|$env:TEAM_SERVER_INTERNAL_TOKEN|$env:SHARED_MYSQL_URL"'
          : 'printf "%s|%s|%s|%s" "${DEEPSEEK_API_KEY:-}" "${STEERABLE_CREDENTIAL_MASTER_KEY:-}" "${TEAM_SERVER_INTERNAL_TOKEN:-}" "${SHARED_MYSQL_URL:-}"',
    });
    expect(shellRes.success).toBe(true);
    expect(shellRes.stdout.trim()).toBe('|||');
    expect(shellRes.stdout).not.toContain('sk-live-tenant-secret-key');
    expect(shellRes.stdout).not.toContain('db_pass_secret_42');

    const codeRes = await executor.runCode({
      language: 'node',
      code: [
        'const keys = [',
        '  "DEEPSEEK_API_KEY",',
        '  "STEERABLE_CREDENTIAL_MASTER_KEY",',
        '  "TEAM_SERVER_INTERNAL_TOKEN",',
        '  "SHARED_MYSQL_URL",',
        '];',
        'console.log(JSON.stringify(keys.map((k) => process.env[k] ?? null)));',
      ].join('\n'),
    });
    expect(codeRes.success).toBe(true);
    expect(JSON.parse(codeRes.stdout.trim())).toEqual([null, null, null, null]);

    // Global secret echoed in output is redacted automatically
    const echoSecret = await executor.executeShell({
      command: 'echo manual-registered-tenant-secret',
    });
    expect(echoSecret.success).toBe(true);
    expect(echoSecret.stdout).toContain('[REDACTED:credential]');
    expect(echoSecret.stdout).not.toContain('manual-registered-tenant-secret');
  });
});
