/**
 * Credential resolution: stored key, provider environment variable, local
 * provider, and nothing at all.
 *
 * The command line, `doctor`, and the TUI banner read the same function, so a
 * disagreement here would make one surface refuse a turn another allows.
 */
import { describe, expect, it } from 'vitest';
import {
  apiKeyEnvNames,
  maskApiKey,
  resolveApiKey,
  withResolvedApiKey,
} from '../../src/storage/llm-settings.js';

describe('resolveApiKey', () => {
  it('prefers the stored key over the environment', () => {
    const resolved = resolveApiKey(
      { provider: 'openai-compat', vendorId: 'deepseek', apiKey: 'sk-stored' },
      { DEEPSEEK_API_KEY: 'sk-env' },
    );
    expect(resolved.key).toBe('sk-stored');
    expect(resolved.source).toEqual({ kind: 'config' });
  });

  it('falls back to the provider environment variable', () => {
    const resolved = resolveApiKey(
      { provider: 'openai-compat', vendorId: 'deepseek' },
      { DEEPSEEK_API_KEY: 'sk-env' },
    );
    expect(resolved.key).toBe('sk-env');
    expect(resolved.source).toEqual({ kind: 'env', name: 'DEEPSEEK_API_KEY' });
  });

  it('reads the variable the selected vendor declares first', () => {
    const resolved = resolveApiKey(
      { provider: 'openai-compat', vendorId: 'openai' },
      { DEEPSEEK_API_KEY: 'sk-deepseek', OPENAI_API_KEY: 'sk-openai' },
    );
    expect(resolved.key).toBe('sk-openai');
    expect(resolved.source).toEqual({ kind: 'env', name: 'OPENAI_API_KEY' });
  });

  it('treats a local provider as needing no key', () => {
    const resolved = resolveApiKey({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, {});
    expect(resolved.key).toBeNull();
    expect(resolved.source).toEqual({ kind: 'not_required' });
    expect(resolved.envNames).toEqual([]);
  });

  it('treats a loopback base URL as needing no key', () => {
    const resolved = resolveApiKey(
      { provider: 'openai-compat', vendorId: 'custom', baseUrl: 'http://localhost:8000/v1' },
      {},
    );
    expect(resolved.source).toEqual({ kind: 'not_required' });
  });

  it('reports missing along with the variables that would fix it', () => {
    const resolved = resolveApiKey({ provider: 'anthropic' }, {});
    expect(resolved.key).toBeNull();
    expect(resolved.source).toEqual({ kind: 'missing' });
    expect(resolved.envNames).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('ignores a blank environment value', () => {
    const resolved = resolveApiKey(
      { provider: 'openai-compat', vendorId: 'deepseek' },
      { DEEPSEEK_API_KEY: '   ' },
    );
    expect(resolved.source).toEqual({ kind: 'missing' });
  });
});

describe('apiKeyEnvNames', () => {
  it('lists the generic openai-compatible variables for an unknown gateway', () => {
    expect(apiKeyEnvNames({ provider: 'openai-compat', vendorId: 'custom' })).toEqual([
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_COMPAT_API_KEY',
    ]);
  });

  it('narrows to one variable for a known vendor', () => {
    expect(apiKeyEnvNames({ provider: 'google', vendorId: 'google' })).toEqual(['GEMINI_API_KEY']);
  });
});

describe('withResolvedApiKey', () => {
  it('drops the absent key instead of leaving an empty string', () => {
    const settings = withResolvedApiKey(
      { provider: 'anthropic', model: 'claude', apiKey: '' },
      {},
    );
    expect('apiKey' in settings).toBe(false);
    expect(settings.model).toBe('claude');
  });

  it('returns the environment key when settings carry none', () => {
    const settings = withResolvedApiKey(
      { provider: 'openai-compat', vendorId: 'deepseek', model: 'deepseek-chat' },
      { DEEPSEEK_API_KEY: 'sk-env' },
    );
    expect(settings.apiKey).toBe('sk-env');
  });
});

describe('maskApiKey', () => {
  it('keeps three leading and four trailing characters', () => {
    expect(maskApiKey('sk-abcdefghijklmn')).toBe('sk-…klmn');
  });

  it('keeps only the tail for a short key', () => {
    expect(maskApiKey('sk-12345')).toBe('…45');
  });

  it('renders nothing for an absent key', () => {
    expect(maskApiKey(undefined)).toBe('');
    expect(maskApiKey('')).toBe('');
  });
});
