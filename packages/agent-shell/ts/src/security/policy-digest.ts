/**
 * Security Policy Digest & Policy-Bound Durable Approval Store (R2-2).
 *
 * Computes a deterministic 16-byte (32-hex) SHA-256 digest over canonical
 * security-relevant fields only (`approvalMode`, `sandboxEnforced`,
 * `writableRoots`, `allowedHosts`, `safetyRules`). Cosmetic or non-security
 * configuration (`model`, `baseUrl`, `theme`, `locale`, `temperature`) is
 * deliberately excluded so changing models or themes preserves `allow_always`
 * grants, while relaxing sandbox or network boundaries invalidates stale grants.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface SecurityPolicyConfig {
  readonly approvalMode?: string;
  readonly sandboxEnforced?: boolean;
  readonly writableRoots?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly safetyRules?: readonly string[];
  /** Non-security fields allowed on merged config objects and ignored in digest. */
  readonly [extraKey: string]: unknown;
}

export type DurableApprovalKind = 'allow_always' | 'deny_always';

function uniqueSorted(items: readonly string[] | undefined, lowerCase = false): string[] {
  if (!items || items.length === 0) return [];
  const set = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    set.add(lowerCase ? trimmed.toLowerCase() : trimmed);
  }
  return [...set].sort();
}

/**
 * Produces the exact same 32-hex SHA-256 prefix as Python's
 * `steerable_agent_runtime.approval.compute_policy_digest`.
 */
export function computePolicyDigest(config: SecurityPolicyConfig = {}): string {
  const canonical = {
    allowedHosts: uniqueSorted(config.allowedHosts, true),
    approvalMode: String(config.approvalMode || 'host'),
    safetyRules: uniqueSorted(config.safetyRules, false),
    sandboxEnforced: Boolean(config.sandboxEnforced),
    writableRoots: uniqueSorted(config.writableRoots, false),
  };
  const encoded = JSON.stringify(canonical);
  return createHash('sha256').update(encoded, 'utf8').digest('hex').slice(0, 32);
}

/**
 * File-backed durable approval grant store partitioned by `policyDigest`
 * (`{"_by_policy": { [policyDigest]: { [category]: "allow_always" | "deny_always" } }}`),
 * compatible with `JsonApprovalStore` in Python and Rust sidecars.
 */
export class PolicyBoundApprovalStore {
  constructor(private readonly filePath: string) {}

  private readRaw(): Record<string, unknown> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  load(policyDigest: string): Record<string, DurableApprovalKind> {
    const raw = this.readRaw();
    const byPolicy = raw._by_policy;
    if (!byPolicy || typeof byPolicy !== 'object' || Array.isArray(byPolicy)) {
      return {};
    }
    const bucket = (byPolicy as Record<string, unknown>)[policyDigest];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      return {};
    }
    const out: Record<string, DurableApprovalKind> = {};
    for (const [k, v] of Object.entries(bucket as Record<string, unknown>)) {
      if (v === 'allow_always' || v === 'deny_always') {
        out[k] = v;
      }
    }
    return out;
  }

  get(policyDigest: string, category: string): DurableApprovalKind | null {
    return this.load(policyDigest)[category] ?? null;
  }

  put(policyDigest: string, category: string, kind: DurableApprovalKind): void {
    const raw = this.readRaw();
    const byPolicy =
      raw._by_policy && typeof raw._by_policy === 'object' && !Array.isArray(raw._by_policy)
        ? { ...(raw._by_policy as Record<string, unknown>) }
        : {};
    const existingBucket = byPolicy[policyDigest];
    const bucket: Record<string, string> =
      existingBucket && typeof existingBucket === 'object' && !Array.isArray(existingBucket)
        ? { ...(existingBucket as Record<string, string>) }
        : {};
    bucket[category] = kind;
    byPolicy[policyDigest] = bucket;
    const next = { ...raw, _by_policy: byPolicy };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(next, null, 1), 'utf8');
    renameSync(tmpPath, this.filePath);
  }
}
