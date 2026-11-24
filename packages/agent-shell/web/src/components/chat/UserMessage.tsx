import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import {
  LuChevronDown,
  LuChevronUp,
  LuCheck,
  LuCopy,
  LuCornerDownRight,
  LuPencil,
} from 'react-icons/lu';
import type { ChatMessage } from '@steerable/agent-protocol';
import type { LocalChat, LocalChatAgent } from '@/lib/local-api';
import { t } from '@/i18n';
import { useSlashSources } from '@/lib/slash-sources';
import { Markdown } from './Markdown';
import { getFriendlyDate } from './timestamp';
import { useCopy } from './useCopy';

interface UserMessageProps {
  message: ChatMessage;
  agents?: LocalChatAgent[];
  chats?: LocalChat[];
  /** Whether this message is part of a consecutive user message group. */
  isGrouped?: boolean;
  /** Whether this message is an appended follow-up inside the group (not the first one). */
  isAppended?: boolean;
  /** Edit and resubmit callback (offered on the latest user message). */
  onEdit?: (nextContent: string) => void | Promise<void>;
}

export function UserMessage({
  message,
  agents = [],
  chats = [],
  isGrouped = false,
  isAppended = false,
  onEdit,
}: UserMessageProps) {
  const content = message.content || '';
  const { skills, mcpTools } = useSlashSources();

  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const swallowPostCompositionEnterRef = useRef(false);
  const enterPressedDuringCompositionRef = useRef(false);
  const { copied, copy } = useCopy(content);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || isExpanded || isEditing) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [content, isExpanded, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }, [isEditing]);

  const startEditing = () => {
    setDraft(content);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setDraft(content);
  };

  const submitEditing = async () => {
    const trimmed = draft.trim();
    if (!trimmed || !onEdit || isSubmittingEdit) return;
    setIsSubmittingEdit(true);
    try {
      setIsEditing(false);
      await onEdit(trimmed);
    } finally {
      setIsSubmittingEdit(false);
    }
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current || event.nativeEvent.isComposing) {
      if (event.key === 'Enter') {
        enterPressedDuringCompositionRef.current = true;
      }
      return;
    }
    if (event.key !== 'Enter') {
      swallowPostCompositionEnterRef.current = false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
      return;
    }
    if (event.key === 'Enter') {
      const sinceEnd = Date.now() - compositionEndAtRef.current;
      if (
        (swallowPostCompositionEnterRef.current && sinceEnd < 300) ||
        sinceEnd < 50
      ) {
        swallowPostCompositionEnterRef.current = false;
        return;
      }
      if (!event.shiftKey) {
        event.preventDefault();
        void submitEditing();
      }
    }
  };

  const handleEditKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter') {
      enterPressedDuringCompositionRef.current = false;
      swallowPostCompositionEnterRef.current = false;
    }
  };

  const renderMessageBody = () => {
    if (isEditing) {
      return (
        <div className="space-y-2" data-testid="user-message-editor">
          <textarea
            ref={editTextareaRef}
            value={draft}
            rows={Math.min(Math.max(draft.split('\n').length, 2), 8)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onKeyUp={handleEditKeyUp}
            onCompositionStart={() => {
              isComposingRef.current = true;
              enterPressedDuringCompositionRef.current = false;
              swallowPostCompositionEnterRef.current = false;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              compositionEndAtRef.current = Date.now();
              swallowPostCompositionEnterRef.current = !enterPressedDuringCompositionRef.current;
              enterPressedDuringCompositionRef.current = false;
            }}
            data-testid="edit-user-message-input"
            className="w-full resize-y rounded-agent-md border border-agent-border bg-agent-background px-2.5 py-1.5 text-xs text-agent-foreground outline-none focus:border-agent-primary"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={cancelEditing}
              data-action="cancel-edit-user-message"
              className="rounded-agent-sm border border-agent-border px-2 py-0.5 text-[11px] text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              disabled={!draft.trim() || isSubmittingEdit}
              onClick={() => void submitEditing()}
              data-action="save-edit-user-message"
              className="rounded-agent-sm bg-agent-primary px-2.5 py-0.5 text-[11px] font-medium text-agent-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('Save and submit')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <>
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
          <div className="flex items-center gap-2">
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
            {onEdit && (
              <button
                type="button"
                onClick={startEditing}
                data-action="edit-user-message"
                className="inline-flex items-center gap-0.5 rounded text-xs text-agent-muted-foreground opacity-0 transition-all duration-200 hover:text-agent-foreground focus:opacity-100 group-hover/message:opacity-100"
                title={t('Edit and resubmit')}
                aria-label={t('Edit message')}
              >
                <LuPencil className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="text-[11px] text-agent-muted-foreground">
            {message.createdAt
              ? getFriendlyDate(new Date(message.createdAt))
              : getFriendlyDate(new Date())}
          </div>
        </div>
      </>
    );
  };

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
        {renderMessageBody()}
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
          {renderMessageBody()}
        </div>
      </div>
    </motion.div>
  );
}

export default UserMessage;
