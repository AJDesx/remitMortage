// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Mocked data layer for Demo/Sandbox mode. Nothing in this file reads from or
 * writes to a live wallet, backend API, or Soroban contract — it exists so
 * prospective users can explore the dashboard before connecting a real wallet.
 */

/** Placeholder address shown while demo mode is active. Never a signable key. */
export const DEMO_PUBLIC_KEY =
  "GDEMO0000000000000000000000000000000000000000000000000000";

export type DemoBorrowerStatus = {
  address: string;
  escrow: { deposited: string; target: string; progress: number };
  loan: { status: string; principal: string; disbursed: string; repaid: string };
};

export const DEMO_BORROWER_STATUS: DemoBorrowerStatus = {
  address: DEMO_PUBLIC_KEY,
  escrow: { deposited: "20400", target: "30000", progress: 68 },
  loan: { status: "Active", principal: "70000", disbursed: "29400", repaid: "4200" },
};

export const DEMO_USDC_BALANCE = "4850.32";
