/**
 * `@steerable/pack-testkit`
 *
 * Provides:
 * 1. `createPackTestHost`: zero-Sidecar in-memory host for testing `@steerable/pack-sdk`
 *    tools (`idempotent: false` `outcome_unknown` settlement, `outward` restricted-channel
 *    blocking, `CredentialInjection` broker), `$source` data bindings (`409 UI_STALE`),
 *    and `DeliverableVerifier`s.
 * 2. `validatePackStaticGuards`: TypeScript AST guard runner checking `scoped-store-only`,
 *    `read-only-purity`, and `extension-core-imports` invariants on external or in-tree packs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type {
  CredentialInjection,
  DeliverableVerificationResult,
  DeliverableVerifier,
  OriginChannel,
  PackCredentialClient,
  PackDataSource,
  Principal,
  ScenarioPack,
  ToolContribution,
} from '@steerable/pack-sdk';

export interface PackGuardViolation {
  readonly rule: 'scoped-store-only' | 'read-only-purity' | 'extension-core-imports';
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface PackStaticGuardReport {
  readonly ok: boolean;
  readonly checkedFiles: number;
  readonly violations: readonly PackGuardViolation[];
}

const FORBIDDEN_WRITE_IDENTIFIERS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
]);

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx|mts|cts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

export function scanSourceTextForPackViolations(
  sourceText: string,
  fileName: string,
  options?: {
    readonly allowStorageDriverPrepare?: boolean;
    readonly checkExtensionImports?: boolean;
  },
): PackGuardViolation[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const violations: PackGuardViolation[] = [];
  const checkExt = options?.checkExtensionImports ?? true;
  const allowPrepare = options?.allowStorageDriverPrepare ?? false;

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  function checkReadOnlyBody(bodyNode: ts.Node, contextLabel: string): void {
    const visitBody = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const expr = n.expression;
        let calleeName = '';
        if (ts.isIdentifier(expr)) {
          calleeName = expr.text;
        } else if (ts.isPropertyAccessExpression(expr)) {
          calleeName = expr.name.text;
        }
        if (FORBIDDEN_WRITE_IDENTIFIERS.has(calleeName)) {
          violations.push({
            rule: 'read-only-purity',
            file: fileName,
            line: lineOf(n),
            message: `${contextLabel} invokes mutating/subprocess API "${calleeName}"`,
          });
        }
      }
      ts.forEachChild(n, visitBody);
    };
    visitBody(bodyNode);
  }

  const visit = (node: ts.Node): void => {
    // 1. Import checks (`scoped-store-only` + `extension-core-imports`)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!allowPrepare && (spec === 'better-sqlite3' || spec === 'mysql2' || spec === 'mysql2/promise')) {
        violations.push({
          rule: 'scoped-store-only',
          file: fileName,
          line: lineOf(node),
          message: `Direct database driver import "${spec}" outside StorageDriver boundary`,
        });
      }
      if (
        checkExt &&
        (/^@steerable\/agent-shell\/src\//.test(spec) ||
          /packages\/agent-shell\/ts\/src\//.test(spec))
      ) {
        violations.push({
          rule: 'extension-core-imports',
          file: fileName,
          line: lineOf(node),
          message: `Scenario pack imports private host path "${spec}"; depend on @steerable/pack-sdk instead`,
        });
      }
    }

    // 2. Direct STEERABLE_CREDENTIAL_MASTER_KEY access in packs
    if (
      checkExt &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'STEERABLE_CREDENTIAL_MASTER_KEY'
    ) {
      violations.push({
        rule: 'extension-core-imports',
        file: fileName,
        line: lineOf(node),
        message:
          'Scenario pack reads STEERABLE_CREDENTIAL_MASTER_KEY directly; use ctx.credentials broker API',
      });
    }

    // 3. Raw `.prepare(...)` SQL statement outside StorageDriver
    if (
      !allowPrepare &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'prepare' &&
      node.arguments.length >= 1 &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))
    ) {
      violations.push({
        rule: 'scoped-store-only',
        file: fileName,
        line: lineOf(node),
        message: 'Raw SQL `.prepare(...)` outside StorageDriver bypasses tenant/user ScopedStore isolation',
      });
    }

    // 4. `read-only-purity`: object literal with `mode: 'read'` + `handler`, or `query` method on PackDataSource
    if (ts.isObjectLiteralExpression(node)) {
      let isReadMode = false;
      let handlerProp: ts.Node | undefined;
      let queryProp: ts.Node | undefined;
      let hasSourceShape = false;

      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          if (
            prop.name.text === 'mode' &&
            ts.isStringLiteral(prop.initializer) &&
            prop.initializer.text === 'read'
          ) {
            isReadMode = true;
          }
          if (prop.name.text === 'handler') {
            handlerProp = prop.initializer;
          }
          if (prop.name.text === 'query') {
            queryProp = prop.initializer;
          }
          if (prop.name.text === 'id' || prop.name.text === 'description') {
            hasSourceShape = true;
          }
        } else if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
          if (prop.name.text === 'handler') handlerProp = prop;
          if (prop.name.text === 'query') queryProp = prop;
        }
      }

      if (isReadMode && handlerProp) {
        checkReadOnlyBody(handlerProp, "mode: 'read' tool handler");
      }
      if (hasSourceShape && queryProp) {
        checkReadOnlyBody(queryProp, 'PackDataSource.query');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

export function validatePackStaticGuards(packRootDir: string): PackStaticGuardReport {
  const files = collectTsFiles(packRootDir);
  const violations: PackGuardViolation[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    violations.push(...scanSourceTextForPackViolations(content, file));
  }
  return {
    ok: violations.length === 0,
    checkedFiles: files.length,
    violations,
  };
}

const DEFAULT_TEST_PRINCIPAL: Principal = {
  id: 'test-user',
  tenantId: 'test-tenant',
  displayName: 'Test Operator',
  email: null,
  isAdmin: false,
  roles: ['operator'],
};

function canonicalHash(value: unknown): string {
  const sortVal = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortVal);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, item]) => [k, sortVal(item)]),
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortVal(value)), 'utf8').digest('hex');
}

export interface PackTestHostOptions {
  readonly pack: ScenarioPack;
  readonly principal?: Principal;
  readonly originChannel?: OriginChannel;
  readonly credentials?: Readonly<Record<string, CredentialInjection>>;
  readonly fetchImpl?: typeof fetch;
}

export interface PackTestToolSettlement {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly effect?: 'none' | 'unknown';
  readonly outcomeUnknown?: boolean;
  readonly retryable?: boolean;
  readonly reconciliationId?: string;
}

export function createPackTestHost(options: PackTestHostOptions) {
  const tools = new Map<string, ToolContribution>();
  const dataSources = new Map<string, PackDataSource>();
  const verifiers = new Map<string, DeliverableVerifier>();
  const pendingReconciliations = new Map<string, { toolName: string; error: string }>();

  for (const t of options.pack.main?.tools ?? []) {
    tools.set(t.name, t);
  }
  for (const ds of options.pack.main?.dataSources ?? []) {
    dataSources.set(ds.id, ds);
  }
  for (const dv of options.pack.main?.deliverableVerifiers ?? []) {
    verifiers.set(dv.id, dv);
  }

  const defaultPrincipal = options.principal ?? DEFAULT_TEST_PRINCIPAL;
  const defaultChannel = options.originChannel ?? 'web';
  const credMap = options.credentials ?? {};
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  function makeCredentialClient(): PackCredentialClient {
    return {
      async resolve(sourceId: string): Promise<CredentialInjection> {
        const found = credMap[sourceId];
        if (!found) {
          throw new Error(`credential_not_configured:${sourceId}`);
        }
        return found;
      },
      async fetch(sourceId: string, url: string | URL, init?: RequestInit): Promise<Response> {
        const inj = await this.resolve(sourceId);
        const target = new URL(String(url));
        if (inj?.query) {
          for (const [k, v] of Object.entries(inj.query)) target.searchParams.set(k, v);
        }
        const headers = new Headers(init?.headers);
        if (inj?.headers) {
          for (const [k, v] of Object.entries(inj.headers)) headers.set(k, v);
        }
        return await fetchFn(target.toString(), { ...init, headers });
      },
    };
  }

  return {
    packId: options.pack.id,
    pendingReconciliations,

    async callTool(
      name: string,
      args: Record<string, unknown>,
      override?: { principal?: Principal; originChannel?: OriginChannel; chatId?: string },
    ): Promise<PackTestToolSettlement> {
      const tool = tools.get(name);
      if (!tool) {
        return { ok: false, error: `Unknown tool: ${name}`, effect: 'none', retryable: false };
      }
      const channel = override?.originChannel ?? defaultChannel;
      const principal = override?.principal ?? defaultPrincipal;

      if (tool.checkpoint === 'outward' && (channel === 'im' || channel === 'webhook')) {
        return {
          ok: false,
          error: 'outward_confirmation_required_in_workbench',
          effect: 'none',
          retryable: false,
        };
      }

      for (const [recId, rec] of pendingReconciliations.entries()) {
        if (rec.toolName === name) {
          return {
            ok: false,
            error: `Blocked by pending reconciliation ${recId}`,
            effect: 'none',
            retryable: false,
            reconciliationId: recId,
          };
        }
      }

      // Pre-dispatch required key check
      const reqKeys = (tool.inputSchema as { required?: unknown })?.required;
      if (Array.isArray(reqKeys)) {
        for (const k of reqKeys) {
          if (typeof k === 'string' && (args[k] === undefined || args[k] === null)) {
            return {
              ok: false,
              error: `Missing required property "${k}"`,
              effect: 'none',
              retryable: true,
            };
          }
        }
      }

      try {
        const result = await tool.handler(args, {
          projectRoot: null,
          chatId: override?.chatId ?? 'test-chat',
          principal,
          originChannel: channel,
          credentials: makeCredentialClient(),
        });
        return { ok: true, result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (tool.idempotent === false) {
          const recId = `rec_${pendingReconciliations.size + 1}`;
          pendingReconciliations.set(recId, { toolName: name, error: msg });
          return {
            ok: false,
            error: msg,
            effect: 'unknown',
            outcomeUnknown: true,
            retryable: false,
            reconciliationId: recId,
          };
        }
        return { ok: false, error: msg, retryable: true };
      }
    },

    async queryDataSource(
      sourceId: string,
      params: Record<string, unknown> = {},
      override?: { principal?: Principal; chatId?: string },
    ): Promise<{ data: unknown; sha256: string }> {
      const ds = dataSources.get(sourceId);
      if (!ds || !ds.query) {
        throw new Error(`Unknown PackDataSource: ${sourceId}`);
      }
      const data = await ds.query(params, {
        principal: override?.principal ?? defaultPrincipal,
        chatId: override?.chatId ?? 'test-chat',
      });
      return { data, sha256: canonicalHash(data) };
    },

    async verifyDeliverable(
      verifierId: string,
      filePath: string,
      executedActions: ReadonlyArray<{
        id?: string;
        tool: string;
        arguments: Record<string, unknown>;
        success: boolean;
      }> = [],
    ): Promise<DeliverableVerificationResult> {
      const v = verifiers.get(verifierId);
      if (!v) throw new Error(`Unknown DeliverableVerifier: ${verifierId}`);
      return await v.verify({
        filePath,
        chatId: 'test-chat',
        principal: defaultPrincipal,
        executedActions,
      });
    },
  };
}
