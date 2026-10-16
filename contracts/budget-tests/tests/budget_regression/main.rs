// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Budget regression scenarios. One module per contract; each exposes
//! `run(&mut Recorder)` which exercises every public entry point with a
//! representative input and the most expensive realistic input.

#[cfg(feature = "escrow")]
mod escrow;

mod governance;
mod insurance_pool;
mod milestone;
mod multisig_validator;
mod oracle_price;
mod staking_pool;
mod verification_registry;
mod yield_vault;

use budget_tests::Recorder;

/// Contracts whose `#[contractimpl]` entry points must all be covered (by a
/// scenario or an exemption in budget-config.json).
const CONTRACTS: &[&str] = &[
    "milestone",
    "governance",
    "insurance-pool",
    "oracle-price",
    "staking-pool",
    "multisig-validator",
    "verification-registry",
    "yield-vault",
    #[cfg(feature = "escrow")]
    "escrow",
];

#[test]
fn contract_budgets() {
    let mut rec = Recorder::new();
    milestone::run(&mut rec);
    governance::run(&mut rec);
    insurance_pool::run(&mut rec);
    oracle_price::run(&mut rec);
    staking_pool::run(&mut rec);
    multisig_validator::run(&mut rec);
    verification_registry::run(&mut rec);
    yield_vault::run(&mut rec);
    #[cfg(feature = "escrow")]
    escrow::run(&mut rec);
    rec.finish(CONTRACTS);
}
