import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@steerable/agent-protocol';
import { LocalChatPanel } from '@/components/chat/LocalChatPanel';
import { ChatHeader } from '@/components/ChatHeader';
import type { ExecutedAction } from '@/components/chat/ExecutedActionsCard';
import type { TurnBlock } from '@/components/chat/turn-timeline';
import type { LocalChat, LocalChatAgent } from '@/lib/local-api';
import { t } from '@/i18n';

/**
 * ChatPanelPreviewPage — dev-only visual harness for `LocalChatPanel`.
 *
 * Mounted at `/preview/chat` in dev. Produces deterministic mock chat data so
 * we can iterate on the message renderer, executed-actions card, copy buttons
 * etc. without needing local-backend to be wired up.
 *
 * Production builds keep the route around (tree-shake'd only when truly dead),
 * but the dataset is small enough (a few hundred lines of mock content) that
 * it's not worth gating behind `import.meta.env.DEV`. If we ever need to,
 * wrap the router entry in `main.tsx` instead of guarding here.
 */

const MOCK_AGENT: LocalChatAgent = {
  id: 'agent_local_default',
  slug: 'local-coder',
  name: 'Local coder',
  icon: '🤖',
  color: '#0ea5e9',
  description: 'Local coding assistant — shell, tool demos, and simple file edits',
  rolePrompt: null,
  isBuiltin: true,
};

const MOCK_CHAT: LocalChat = {
  id: 'preview-chat',
  projectId: null,
  userId: 'preview-user',
  title: 'Preview: check the service, then run the test suite',
  agentId: MOCK_AGENT.id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isPinned: false,
  systemPrompt: null,
  pinnedRefs: null,
};

const MOCK_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: 'Check whether the local service is up, then run the test suite in this directory.',
    createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: 'm2',
    role: 'assistant',
    agentId: MOCK_AGENT.id,
    content: `I'll check the service, then run the tests.

\`\`\`bash
$ check_connection
✓ Mock service @ 127.0.0.1:8765 reachable (latency 4ms)
\`\`\`

The connection is fine. Next, the test suite:

\`\`\`bash
$ npm test
PASS  src/components/chat/ChatInput.test.tsx
PASS  src/components/chat/MessageList.test.tsx
FAIL  src/components/chat/AssistantMessage.test.tsx
  ✗ renders agent badge when agentId present (5 ms)
    Expected color "#0ea5e9", got "#7c3aed"

Tests: 1 failed, 2 passed, 3 total
\`\`\`

1 failure: \`AssistantMessage\` did not take the agent color from props. Use \`a.color ?? '#7c3aed'\` before \`agentInitial\` so the fallback wins over the hardcoded color.

Want me to edit that file?`,
    createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
  },
];

const MOCK_TODOS = [
  { id: 'survey', content: 'Check service connectivity', status: 'completed' as const },
  { id: 'test', content: 'Run the test suite in this directory', status: 'in_progress' as const },
  { id: 'fix', content: 'Fix the failing assertion color', status: 'pending' as const },
];

const MOCK_TODO_ACTION: ExecutedAction = {
  tool: 'todo_write',
  arguments: { todos: MOCK_TODOS },
  result: {
    success: true,
    data: {
      value: {
        todos: MOCK_TODOS,
        summary: { total: 3, pending: 1, inProgress: 1, completed: 1 },
      },
    },
  },
};

const MOCK_ACTIONS: ExecutedAction[] = [
  MOCK_TODO_ACTION,
  {
    tool: 'check_connection',
    arguments: { host: '127.0.0.1', port: 8765 },
    result: { success: true, latencyMs: 4 },
  },
  {
    tool: 'shell_run',
    arguments: { command: 'npm test', cwd: '/home/me/proj' },
    result: {
      success: false,
      exitCode: 1,
      stdout: '...test output truncated...',
      stderr: 'Tests: 1 failed, 2 passed, 3 total',
    },
  },
  {
    tool: 'fs_read_file',
    arguments: { path: 'src/components/chat/AssistantMessage.tsx' },
    result: { success: true, bytes: 4096 },
  },
];

const MOCK_TIMELINE: TurnBlock[] = [
  { type: 'reasoning', content: 'Check connectivity first, then run the test suite.' },
  { type: 'tools', actions: [MOCK_TODO_ACTION] },
  { type: 'tools', actions: [MOCK_ACTIONS[1]] },
  { type: 'text', content: 'The connection is fine. Next, the test suite.' },
  { type: 'tools', actions: [MOCK_ACTIONS[2]] },
  { type: 'reasoning', content: 'The tests failed. Read the failing file, then suggest a fix.' },
  { type: 'tools', actions: [MOCK_ACTIONS[3]] },
  { type: 'text', content: MOCK_MESSAGES[1].content ?? '' },
];

/**
 * Three scenarios to flip between with the top-right pill buttons:
 *   • `static`     — finished conversation; verifies copy buttons, action
 *     cards, markdown rendering on history.
 *   • `thinking`   — in-flight assistant bubble before any content; verifies
 *     StreamingStatus's "Now thinking..." baseline.
 *   • `tools-run`  — in-flight bubble, round 2, 2 tools just ran; verifies
 *     StreamingStatus's "Called N tools" line and the Round N badge.
 *   • `reasoning-stream` — reasoning tokens arrive over time; verifies the
 *     5-line peek stays visible and the list scrollbar sticks to the bottom.
 */
type PreviewScene = 'static' | 'thinking' | 'tools-run' | 'reasoning-stream';

const STREAMING_REASONING = [
  'Check whether the service is still reachable.',
  'If the port is open, run the test suite in this directory.',
  'If it fails, read only the failing file. Do not scan the whole repo.',
  "When an assertion color is wrong, look at AssistantMessage's default color first.",
  'After the edit, run the tests again and check for new failures.',
  'Keep tool calls few: connectivity, tests, and a file read only if needed.',
  'Finish with one or two sentences on the result and the next step.',
  'If thinking is still streaming, later sentences are cut by the 5-line window.',
  'Comparing a < b must not be eaten as an HTML tag by Markdown.',
  'The scrollbar should stay pinned to the bottom and not jump with each token.',
].join('\n');

function previewScenes(): { id: PreviewScene; label: string }[] {
  return [
    { id: 'static', label: t('Static history') },
    { id: 'thinking', label: t('Streaming · empty content') },
    { id: 'tools-run', label: t('Streaming · tools ran · round 2') },
    { id: 'reasoning-stream', label: t('Streaming · reasoning typing') },
  ];
}

export function ChatPanelPreviewPage() {
  const [scene, setScene] = useState<PreviewScene>('static');
  const [streamedReasoning, setStreamedReasoning] = useState('');

  useEffect(() => {
    if (scene !== 'reasoning-stream') {
      setStreamedReasoning('');
      return;
    }
    setStreamedReasoning('');
    let index = 0;
    const id = window.setInterval(() => {
      index += 2;
      if (index >= STREAMING_REASONING.length) {
        setStreamedReasoning(STREAMING_REASONING);
        window.clearInterval(id);
        return;
      }
      setStreamedReasoning(STREAMING_REASONING.slice(0, index));
    }, 40);
    return () => window.clearInterval(id);
  }, [scene]);

  // Explicit struct type so TS doesn't try to narrow `actionsByMsgId` to the
  // union of {} | { m2: ... } — both shapes are valid `Record<string, ...>`
  // but the inferred type rejects each side mutually.
  interface SceneConfig {
    messages: ChatMessage[];
    isStreaming: boolean;
    actionsByMsgId: Record<string, ExecutedAction[]>;
    currentTurnActions: ExecutedAction[];
    timelineByMsgId: Record<string, TurnBlock[]>;
    currentTurnTimeline?: TurnBlock[];
    currentTurnStartedAtMs?: number;
    durationByMessageId?: Record<string, number>;
    currentRound: number;
    suggestedReplies?: string[];
  }
  const config = useMemo<SceneConfig>(() => {
    switch (scene) {
      case 'thinking':
        return {
          messages: [
            MOCK_MESSAGES[0],
            {
              id: 'm-streaming',
              role: 'assistant',
              agentId: MOCK_AGENT.id,
              content: '',
              createdAt: new Date().toISOString(),
            },
          ],
          isStreaming: true,
          actionsByMsgId: {} as Record<string, ExecutedAction[]>,
          currentTurnActions: [],
          timelineByMsgId: {} as Record<string, TurnBlock[]>,
          currentTurnTimeline: [],
          currentRound: 1,
        };
      case 'tools-run':
        return {
          messages: [
            MOCK_MESSAGES[0],
            {
              id: 'm-streaming',
              role: 'assistant',
              agentId: MOCK_AGENT.id,
              content: '',
              createdAt: new Date().toISOString(),
            },
          ],
          isStreaming: true,
          actionsByMsgId: {} as Record<string, ExecutedAction[]>,
          currentTurnActions: MOCK_ACTIONS.slice(0, 2),
          timelineByMsgId: {} as Record<string, TurnBlock[]>,
          currentTurnTimeline: [
            {
              type: 'reasoning',
              content: [
                'Check whether the service is still reachable.',
                'If the port is open, run the test suite in this directory.',
                'If it fails, read only the failing file. Do not scan the whole repo.',
                "When an assertion color is wrong, look at AssistantMessage's default color first.",
                'After the edit, run the tests again and check for new failures.',
                'Keep tool calls few: connectivity, tests, and a file read only if needed.',
                'Finish with one or two sentences on the result and the next step.',
                'If thinking is still streaming, later sentences are cut by the 5-line window.',
              ].join('\n'),
            },
            {
              type: 'tools',
              actions: [MOCK_ACTIONS[0], { ...MOCK_ACTIONS[1], result: undefined }],
            },
          ],
          currentTurnStartedAtMs: Date.now() - 12_000,
          currentRound: 2,
        };
      case 'reasoning-stream':
        return {
          messages: [
            MOCK_MESSAGES[0],
            {
              id: 'm-streaming',
              role: 'assistant',
              agentId: MOCK_AGENT.id,
              content: '',
              createdAt: new Date().toISOString(),
            },
          ],
          isStreaming: true,
          actionsByMsgId: {} as Record<string, ExecutedAction[]>,
          currentTurnActions: [],
          timelineByMsgId: {} as Record<string, TurnBlock[]>,
          currentTurnTimeline: streamedReasoning
            ? [{ type: 'reasoning', content: streamedReasoning }]
            : [],
          currentTurnStartedAtMs: Date.now() - 1_000,
          currentRound: 1,
        };
      case 'static':
      default:
        return {
          messages: MOCK_MESSAGES,
          isStreaming: false,
          actionsByMsgId: { m2: MOCK_ACTIONS },
          currentTurnActions: [],
          timelineByMsgId: { m2: MOCK_TIMELINE },
          durationByMessageId: { m2: 83_000 },
          currentRound: 1,
          suggestedReplies: ['Fix the failing assertion color', 'Run the tests again', 'Explain this failure'],
        };
    }
  }, [scene, streamedReasoning]);

  return (
    <div className="flex h-full w-full flex-col bg-agent-muted/30">
      <div className="flex shrink-0 items-center gap-2 border-b border-agent-border bg-agent-canvas px-2.5 py-1.5 text-xs">
        <span className="text-agent-muted-foreground">
          /preview/chat (dev harness)
        </span>
        <div className="flex gap-1">
          {previewScenes().map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setScene(s.id)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                scene === s.id
                  ? 'border-agent-foreground/40 bg-agent-foreground/10 text-agent-foreground'
                  : 'border-agent-border bg-agent-canvas text-agent-muted-foreground hover:bg-agent-foreground/5'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="m-2 flex flex-1 overflow-hidden rounded-agent-lg bg-agent-canvas shadow-sm">
        <LocalChatPanel
          messages={config.messages}
          isStreaming={config.isStreaming}
          onSubmit={async ({ content }) => {
            console.log('[preview] submit:', content);
          }}
          onCancel={() => {}}
          className="flex-1"
          header={
            <ChatHeader chat={MOCK_CHAT} />
          }
          inputPlaceholder={t('Preview mode: input is not actually sent…')}
          agents={[MOCK_AGENT]}
          currentAgent={MOCK_AGENT}
          executedActionsByMessageId={config.actionsByMsgId}
          currentTurnActions={config.currentTurnActions}
          timelineByMessageId={config.timelineByMsgId}
          currentTurnTimeline={config.currentTurnTimeline}
          currentTurnStartedAtMs={config.currentTurnStartedAtMs}
          durationByMessageId={config.durationByMessageId}
          currentRound={config.currentRound}
          suggestedReplies={config.suggestedReplies}
          onSelectSuggestion={(text) => console.log('[preview] suggestion:', text)}
          onOpenSettings={() =>
            console.log('[preview] open llm settings (noop in harness)')
          }
        />
      </div>
    </div>
  );
}

export default ChatPanelPreviewPage;
