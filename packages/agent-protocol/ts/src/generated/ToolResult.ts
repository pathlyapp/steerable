export interface ToolResult {
  success: boolean;
  terminal?: boolean;
  needsFollowup?: boolean;
  nextAction?: string;
  message?: string;
  error?: string;
  effect?: "none" | "committed" | "unknown";
  outcomeUnknown?: boolean;
  retryable?: boolean;
  reconciliationId?: string;
  data?: {
    [k: string]: any;
  };
  [k: string]: any;
}
