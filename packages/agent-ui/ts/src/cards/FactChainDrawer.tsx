/**
 * `<FactChainDrawer />`
 *
 * Read-only execution provenance & deliverable evidence drawer (wireframes W6 & W7).
 * Displays only authoritative ledger facts:
 * - `requestNode`: model, `policyDigest`, attachment hashes — or honest `status: 'gap'` notice.
 * - `toolNodes`: real executed / `outcome_unknown` tool records — or explicit `no_tool_evidence`
 *   notice when the assistant answered from model parameters alone (never quoting prose as evidence).
 * - `deliverableNode`: verifier results, `snapshotSha256`, live workspace drift warning
 *   (`'unchanged' | 'modified' | 'deleted'`), and immutable snapshot download URL.
 */
import * as React from 'react';

export interface FactChainRequestNode {
  readonly status: 'recorded' | 'gap';
  readonly model?: string;
  readonly policyDigest?: string;
  readonly systemPromptSummary?: string;
  readonly attachmentHashes?: readonly string[];
  readonly gapReason?: string;
}

export interface FactChainToolNode {
  readonly id: string;
  readonly toolName: string;
  readonly argsSummary: string;
  readonly status: 'executed' | 'outcome_unknown' | 'failed';
  readonly durationMs?: number;
}

export interface FactChainDeliverableNode {
  readonly id: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly verificationStatus: 'verified' | 'warnings' | 'failed' | 'unverified';
  readonly verifierSummary?: string | null;
  readonly snapshotSha256: string;
  readonly workspaceState: 'unchanged' | 'modified' | 'deleted';
  readonly snapshotDownloadUrl?: string | null;
}

export interface FactChainGraph {
  readonly chatId: string;
  readonly targetKind: 'message' | 'tool' | 'deliverable';
  readonly targetId: string;
  readonly requestNode: FactChainRequestNode;
  readonly evidenceStatus: 'recorded' | 'no_tool_evidence' | 'gap';
  readonly toolNodes: readonly FactChainToolNode[];
  readonly deliverableNode?: FactChainDeliverableNode | null;
}

export interface FactChainDrawerProps {
  graph: FactChainGraph | null;
  open: boolean;
  onClose?: () => void;
  className?: string;
}

export const FactChainDrawer: React.FC<FactChainDrawerProps> = ({
  graph,
  open,
  onClose,
  className = '',
}) => {
  if (!open || !graph) return null;

  const deliv = graph.deliverableNode;

  return (
    <aside
      aria-label="Fact Chain"
      data-testid="fact-chain-drawer"
      className={`flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-lg dark:border-slate-800 dark:bg-slate-950 ${className}`.trim()}
    >
      <div className="flex items-center justify-between border-b border-slate-200 pb-2.5 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Execution evidence chain (Fact Chain)
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            data-testid="fact-chain-close"
            className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-900"
          >
            Close
          </button>
        ) : null}
      </div>

      {/* Workspace tamper / deletion warning */}
      {deliv && deliv.workspaceState !== 'unchanged' ? (
        <div
          role="alert"
          data-testid="fact-chain-workspace-drift"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-950 dark:text-amber-200"
        >
          ⚠ Workspace file was {deliv.workspaceState} after verification. The immutable snapshot
          link below still serves the exact bytes that passed verification.
        </div>
      ) : null}

      {/* 1. Request context node */}
      <section className="space-y-1 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <div className="font-semibold text-slate-800 dark:text-slate-200">
          1. Request snapshot
        </div>
        {graph.requestNode.status === 'gap' ? (
          <p data-testid="fact-chain-request-gap" className="text-amber-700 dark:text-amber-300">
            Missing record ({graph.requestNode.gapReason || 'imported_without_request_snapshot'})
          </p>
        ) : (
          <div className="space-y-1 text-slate-600 dark:text-slate-400">
            {graph.requestNode.model ? <div>Model: {graph.requestNode.model}</div> : null}
            {graph.requestNode.policyDigest ? (
              <div className="font-mono">
                Policy digest: {graph.requestNode.policyDigest}
              </div>
            ) : null}
            {graph.requestNode.attachmentHashes &&
            graph.requestNode.attachmentHashes.length > 0 ? (
              <div className="font-mono">
                Input SHA-256: {graph.requestNode.attachmentHashes.join(', ')}
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* 2. Tool execution nodes */}
      <section className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <div className="font-semibold text-slate-800 dark:text-slate-200">
          2. Tool execution receipts
        </div>
        {graph.evidenceStatus === 'no_tool_evidence' || graph.toolNodes.length === 0 ? (
          <p data-testid="fact-chain-no-tool-evidence" className="text-slate-500">
            No tool evidence recorded for this response (generated without tool calls).
          </p>
        ) : (
          <ul className="space-y-1.5">
            {graph.toolNodes.map((node) => (
              <li
                key={node.id}
                data-testid={`fact-chain-tool-${node.id}`}
                className="rounded border border-slate-100 bg-slate-50/70 p-2 dark:border-slate-800 dark:bg-slate-900/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-medium">{node.toolName}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      node.status === 'executed'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : node.status === 'outcome_unknown'
                          ? 'bg-amber-500/20 text-amber-800 dark:text-amber-200'
                          : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                    }`}
                  >
                    {node.status}
                  </span>
                </div>
                {node.argsSummary ? (
                  <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
                    {node.argsSummary}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Deliverable verification & snapshot */}
      {deliv ? (
        <section
          data-testid="fact-chain-deliverable"
          className="space-y-1.5 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
        >
          <div className="font-semibold text-slate-800 dark:text-slate-200">
            3. Verified deliverable snapshot
          </div>
          <div className="font-medium text-slate-900 dark:text-slate-100">
            {deliv.fileName} ({deliv.verificationStatus})
          </div>
          {deliv.verifierSummary ? (
            <div className="text-slate-600 dark:text-slate-400">{deliv.verifierSummary}</div>
          ) : null}
          <div className="font-mono text-[11px] text-slate-500">
            Snapshot SHA-256: {deliv.snapshotSha256}
          </div>
          {deliv.snapshotDownloadUrl ? (
            <a
              href={deliv.snapshotDownloadUrl}
              data-testid="fact-chain-download-snapshot"
              className="inline-block rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
            >
              Download verified snapshot
            </a>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
};
