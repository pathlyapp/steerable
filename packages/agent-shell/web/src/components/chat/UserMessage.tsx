import { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { LuChevronDown, LuChevronUp, LuCheck, LuCopy, LuCornerDownRight } from 'react-icons/lu';
import type { ChatMessage } from '@steerable/agent-protocol';
import type { LocalChat, LocalChatAgent } from '@/lib/local-api';
import { t } from '@/i18n';
import { useSlashSources } from '@/lib/slash-sources';
import { Markdown } from './Markdown';
import { getFriendlyDate } from './timestamp';
import { useCopy } from './useCopy';

/**
 * UserMessage — port of `deeppath`'s user-bubble component, trimmed to the
 * agent-only surface.
 *
 * Grouping (方案 A):
 *   When multiple user messages occur consecutively without an assistant reply
 *   in between, MessageList renders them as a single connected card:
 *   - The first message has `isGroupStart = true`
 *   - Mid-turn / follow-up steered additions have `isAppended = true`
 *   - The outer container groups them with a subtle dashed divider and a
 *     「↳ 追加」 badge.
 */

interface UserMessageProps {
  message: ChatMessage;
  agents?: LocalChatAgent[];
  chats?: LocalChat[];
  /** Whether this message is part of a consecutive user message group. */
  isGrouped?: boolean;
  /** Whether this message is an appended follow-up inside the group (not the first one). */
  isAppended?: boolean;
}

export function UserMessage({
  message,
  agents = [],
  chats = [],
  isGrouped = false,
  isAppended = false,
}: UserMessageProps) {
  const content = message.content || '';
  // 发出去的消息里 `/技能` `/mcp__srv__tool` 要和输入框里同样渲染成工具卡片。
  // 目录来自共享缓存，整屏消息只拉一次。
  const { skills, mcpTools } = useSlashSources();

  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy(content);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || isExpanded) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [content, isExpanded]);

  // When rendered as an item inside a group, the parent handles the outer card.
  if (isGrouped) {
    return (
      <div
        className={`group/message relative px-3 py-2 text-xs text-agent-foreground ${
          isAppended ? 'border-t border-dashed border-agent-border/60 bg-agent-muted/30' : ''
        }`}
        data-message-role="user"
        data-message-id={message.id}
      >
        {isAppended && (
          <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-agent-muted-foreground select-none">
            <LuCornerDownRight className="h-3 w-3 text-agent-primary/80" />
            <span className="rounded bg-agent-primary/10 px-1 py-0.5 text-[10px] text-agent-primary font-medium">
              {t('Appended')}
            </span>
          </div>
        )}
        <div className="relative">
          <div
            ref={contentRef}
            className={`markdown-content pl-1 ${
              !isExpanded ? 'overflow-hidden' : ''
            }`}
            style={!isExpanded ? { maxHeight: '4.5em' } : undefined}
          >
            {content ? (
              <Markdown
                inlineParagraph
                agents={agents}
                chats={chats}
                skills={skills}
                mcpTools={mcpTools}
              >
                {content}
              </Markdown>
            ) : (
              <div className="h-4" />
            )}
          </div>
          {!isExpanded && isOverflowing && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-t from-agent-muted to-transparent" />
          )}
        </div>

        {isOverflowing && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIsExpanded((prev) => !prev);
            }}
            className="mt-1 inline-flex items-center gap-0.5 text-xs text-agent-muted-foreground transition-colors hover:text-agent-foreground"
          >
            {isExpanded ? (
              <>
                {t('Collapse')}
                <LuChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                {t('Expand all')}
                <LuChevronDown className="h-3 w-3" />
              </>
            )}
          </button>
        )}

        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-0.5 rounded text-xs text-agent-muted-foreground opacity-0 transition-all duration-200 hover:text-agent-foreground focus:opacity-100 group-hover/message:opacity-100"
            title={copied ? t('Copied') : t('Copy message')}
            aria-label={copied ? t('Copied') : t('Copy message')}
          >
            {copied ? (
              <>
                <LuCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400">
                  {t('Copied')}
                </span>
              </>
            ) : (
              <LuCopy className="h-3 w-3" />
            )}
          </button>
          <div className="text-[11px] text-agent-muted-foreground">
            {message.createdAt
              ? getFriendlyDate(new Date(message.createdAt))
              : getFriendlyDate(new Date())}
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="group/message"
      data-message-role="user"
      data-message-id={message.id}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex justify-start">
        <div className="mx-auto w-full max-w-[var(--chat-input-box-width)] rounded-agent-lg border border-agent-border/80 bg-agent-muted/70 px-3 py-2 text-xs text-agent-foreground">
          <div className="relative">
            <div
              ref={contentRef}
              className={`markdown-content pl-1 ${
                !isExpanded ? 'overflow-hidden' : ''
              }`}
              style={!isExpanded ? { maxHeight: '4.5em' } : undefined}
            >
              {content ? (
                <Markdown
                  inlineParagraph
                  agents={agents}
                  chats={chats}
                  skills={skills}
                  mcpTools={mcpTools}
                >
                  {content}
                </Markdown>
              ) : (
                <div className="h-4" />
              )}
            </div>
            {!isExpanded && isOverflowing && (
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-t from-agent-muted to-transparent" />
            )}
          </div>

          {isOverflowing && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setIsExpanded((prev) => !prev);
              }}
              className="mt-1 inline-flex items-center gap-0.5 text-xs text-agent-muted-foreground transition-colors hover:text-agent-foreground"
            >
              {isExpanded ? (
                <>
                  {t('Collapse')}
                  <LuChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  {t('Expand all')}
                  <LuChevronDown className="h-3 w-3" />
                </>
              )}
            </button>
          )}

          <div className="mt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex items-center gap-0.5 rounded text-xs text-agent-muted-foreground opacity-0 transition-all duration-200 hover:text-agent-foreground focus:opacity-100 group-hover/message:opacity-100"
              title={copied ? t('Copied') : t('Copy message')}
              aria-label={copied ? t('Copied') : t('Copy message')}
            >
              {copied ? (
                <>
                  <LuCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {t('Copied')}
                  </span>
                </>
              ) : (
                <LuCopy className="h-3 w-3" />
              )}
            </button>
            <div className="text-[11px] text-agent-muted-foreground">
              {message.createdAt
                ? getFriendlyDate(new Date(message.createdAt))
                : getFriendlyDate(new Date())}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default UserMessage;
