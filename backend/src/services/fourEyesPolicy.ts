// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Policy for which admin actions require a second, distinct admin's
 * approval before executing (issue #841) — by action type and, for
 * amount-gated types, by a dollar threshold.
 */

export interface FourEyesActionDefinition {
  actionType: string;
  description: string;
  /** Null = always requires approval regardless of amount. */
  amountThreshold: number | null;
}

export const FOUR_EYES_ACTIONS: Record<string, FourEyesActionDefinition> = {
  LOAN_SERVICING_TRANSFER: {
    actionType: "LOAN_SERVICING_TRANSFER",
    description: "Transfer servicing of a loan to a new servicer",
    amountThreshold: 50_000,
  },
  ESCROW_RECONCILE_AUTOCORRECT: {
    actionType: "ESCROW_RECONCILE_AUTOCORRECT",
    description: "Auto-correct an escrow balance mismatch",
    amountThreshold: 10_000,
  },
  SCORING_MODEL_UPDATE: {
    actionType: "SCORING_MODEL_UPDATE",
    description: "Change the active or shadow credit scoring model",
    amountThreshold: null,
  },
  AUTO_REJECTION_RULE_CHANGE: {
    actionType: "AUTO_REJECTION_RULE_CHANGE",
    description: "Create or update an automated application-rejection rule",
    amountThreshold: null,
  },
};

export function getActionDefinition(actionType: string): FourEyesActionDefinition | null {
  return FOUR_EYES_ACTIONS[actionType] ?? null;
}

/**
 * Whether this action, at this amount, must go through four-eyes approval
 * rather than executing immediately. An unrecognized action type never
 * requires approval — only actions explicitly registered above are gated,
 * so this never silently blocks an action nobody opted in.
 */
export function requiresFourEyesApproval(actionType: string, amount: number | null): boolean {
  const def = getActionDefinition(actionType);
  if (!def) return false;
  if (def.amountThreshold === null) return true;
  return (amount ?? 0) >= def.amountThreshold;
}
