/**
 * `steerable-cli diag-bundle` privacy-safe diagnostic archive exporter (Phase 9 R9-2).
 *
 * Security & air-gapped compliance invariants (`T-FDE-05` & `T-MEM-09`):
 * 1. Never traverses or packages `<dataDir>/memory/` or `credential-master-key.bin`.
 * 2. Scrubs all registered credentials and common API-key/Bearer patterns via `SecretRedactor`.
 * 3. Defaults `--redact-content` to `true`: replaces user prompts, assistant replies,
 *    and document text with `"[REDACTED len=<chars> sha256=<hex12>]"` while preserving
 *    protocol event skeletons, tool names, durations, and error codes!
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretRedactor } from '@steerable/agent-shell/auth/credentials';

const COMMON_SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b|(?:Bearer|Basic|api[_-]?key\s*[:=])\s+[A-Za-z0-9._\-+/=]{10,}/gi;

export function summarizeRedactedText(raw: string): string {
  const hash12 = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  return `[REDACTED len=${raw.length} sha256=${hash12}]`;
}

function scrubFreeText(raw: string, redactor: SecretRedactor): string {
  return redactor.redact(raw).replace(COMMON_SECRET_RE, '[REDACTED_CREDENTIAL]');
}

export interface ChatDiagnosticInput {
  readonly id: string;
  readonly title?: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly content: string;
    readonly createdAt?: string;
    readonly metadata?: Record<string, unknown> | null;
  }>;
}

export interface ExportDiagBundleOptions {
  readonly dataDir: string;
  readonly outFile: string;
  readonly redactContent?: boolean;
  readonly extraSecrets?: readonly string[];
  readonly chats?: readonly ChatDiagnosticInput[];
}

export function exportDiagBundle(options: ExportDiagBundleOptions): {
  readonly outFile: string;
  readonly redactContent: boolean;
  readonly includedFiles: readonly string[];
} {
  const redactContent = options.redactContent !== false;
  const redactor = new SecretRedactor();
  for (const s of options.extraSecrets ?? []) {
    redactor.registerSecret(s);
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerable-diag-'));
  const includedFiles: string[] = [];

  try {
    // 1. Sanitized environment & platform metadata
    const envInfo = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      osRelease: os.release(),
      redactContent,
      excludedPrivateDirs: ['memory/', 'authoring-candidates/', 'credential-master-key.bin'],
    };
    fs.writeFileSync(
      path.join(stageDir, 'environment.json'),
      JSON.stringify(envInfo, null, 2),
      'utf8',
    );
    includedFiles.push('environment.json');

    // 2. Scrubbed recent host logs (explicitly skipping `memory` & `credential-master-key.bin`)
    const logsDir = path.join(options.dataDir, 'logs');
    if (fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory()) {
      fs.mkdirSync(path.join(stageDir, 'logs'), { recursive: true });
      for (const entry of fs.readdirSync(logsDir)) {
        if (!entry.endsWith('.log') && !entry.endsWith('.txt')) continue;
        const rawLog = fs.readFileSync(path.join(logsDir, entry), 'utf8');
        const safeLog = redactContent
          ? rawLog
              .split('\n')
              .map((line) => {
                const scrubbed = scrubFreeText(line, redactor);
                // Strip quoted user/document content fragments in logs if any
                return scrubbed.replace(/"content"\s*:\s*"[^"]*"/g, '"content":"[REDACTED]"');
              })
              .join('\n')
          : scrubFreeText(rawLog, redactor);
        fs.writeFileSync(path.join(stageDir, 'logs', entry), safeLog, 'utf8');
        includedFiles.push(`logs/${entry}`);
      }
    }

    // 3. Chat protocol skeletons (preserving LoopEvent / tool names / latency / error codes, redacting prose!)
    if (options.chats && options.chats.length > 0) {
      const skeletons = options.chats.map((chat) => ({
        chatId: chat.id,
        title: redactContent && chat.title ? summarizeRedactedText(chat.title) : scrubFreeText(chat.title ?? '', redactor),
        events: chat.messages.map((m) => {
          const rawActions = Array.isArray(m.metadata?.executedActions)
            ? (m.metadata!.executedActions as Array<Record<string, unknown>>)
            : [];
          return {
            messageId: m.id,
            role: m.role,
            createdAt: m.createdAt ?? null,
            content: redactContent
              ? summarizeRedactedText(m.content)
              : scrubFreeText(m.content, redactor),
            loopEvents: Array.isArray(m.metadata?.loopEvents)
              ? (m.metadata!.loopEvents as Array<Record<string, unknown>>).map((ev) => ({
                  kind: ev.kind ?? ev.type ?? 'event',
                  status: ev.status ?? null,
                  errorCode: ev.errorCode ?? ev.code ?? null,
                  durationMs: ev.durationMs ?? null,
                }))
              : [],
            executedActions: rawActions.map((act) => ({
              id: act.id ?? null,
              tool: act.tool ?? act.name ?? 'unknown',
              success: act.success ?? null,
              effect: act.effect ?? null,
              outcomeUnknown: act.outcomeUnknown ?? false,
              errorCode: act.errorCode ?? (typeof act.error === 'string' ? scrubFreeText(act.error.slice(0, 80), redactor) : null),
              durationMs: act.durationMs ?? null,
              argumentsSummary: redactContent
                ? summarizeRedactedText(JSON.stringify(act.arguments ?? {}))
                : scrubFreeText(JSON.stringify(act.arguments ?? {}), redactor),
            })),
          };
        }),
      }));

      fs.writeFileSync(
        path.join(stageDir, 'chat-skeletons.json'),
        JSON.stringify(skeletons, null, 2),
        'utf8',
      );
      includedFiles.push('chat-skeletons.json');
    }

    const resolvedOut = path.resolve(options.outFile);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    execFileSync('tar', ['-czf', resolvedOut, '-C', stageDir, ...includedFiles]);
    return {
      outFile: resolvedOut,
      redactContent,
      includedFiles,
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}
