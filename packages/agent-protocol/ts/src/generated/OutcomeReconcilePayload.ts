export interface OutcomeReconcilePayload {
  reconciliationId: string;
  toolName: string;
  argsPreview?: string;
  errorDetail?: string;
  status: "pending" | "confirmed_executed" | "confirmed_not_executed";
  resolutionNote?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  [k: string]: any;
}
