// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for admin-approved hardship withdrawal from escrow.

#![cfg(test)]

use crate::types::EscrowConfig;
use crate::{EscrowContract, EscrowContractClient, EscrowError};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Symbol,
};

fn base_config(admin: Address, token: Address, lending_pool: Address) -> EscrowConfig {
    EscrowConfig {
        admin,
        token,
        lending_pool,
        savings_target: 10_000_0000000i128,
        max_duration_ledgers: 518_400u32,
        early_withdrawal_penalty_bps: 500u32,
        min_duration_ledgers: 0u32,
        penalty_bps_tier1: 500u32,
        penalty_bps_tier2: 300u32,
        penalty_bps_tier3: 150u32,
        penalty_bps_tier4: 50u32,
        grace_period_ledgers: 10u32,
        default_penalty_bps: 1000u32,
        instance_bump_amount: 518_400u32,
        instance_lifetime_threshold: 129_600u32,
        persistent_bump_amount: 518_400u32,
        persistent_lifetime_threshold: 129_600u32,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    }
}

fn setup(env: &Env) -> (EscrowContractClient<'_>, Address, Address, Address, Address) {
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 1_000_000;
    });

    let admin = Address::generate(env);
    let borrower = Address::generate(env);
    let lending_pool = Address::generate(env);

    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_id.address();
    StellarAssetClient::new(env, &token_address).mint(&borrower, &50_000_0000000i128);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    (client, admin, borrower, token_address, lending_pool)
}

fn reason(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn test_approved_hardship_withdrawal_pays_full_amount_and_records_approver() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(
        admin.clone(),
        token_address.clone(),
        lending_pool,
    ));

    let goal_id = Symbol::new(&env, "house");
    let deposit_amount = 3_000_0000000i128;
    client.deposit(&borrower, &goal_id, &deposit_amount);

    // Still well inside the normal early-withdrawal penalty window (month 1).
    let reason_hash = reason(&env, 0xAB);
    client.request_hardship_withdrawal(&borrower, &goal_id, &reason_hash);

    let request = client.get_hardship_request(&borrower, &goal_id).unwrap();
    assert!(!request.approved);

    client.approve_hardship_withdrawal(&borrower, &goal_id);
    let approved = client.get_hardship_request(&borrower, &goal_id).unwrap();
    assert!(approved.approved);
    assert_eq!(approved.approver, Some(admin.clone()));
    assert_eq!(approved.reason_hash, reason_hash);

    let token = TokenClient::new(&env, &token_address);
    let balance_before = token.balance(&borrower);

    let refund = client.withdraw_hardship(&borrower, &goal_id);

    // Zero penalty: the FULL deposited amount comes back, unlike the normal
    // path which would deduct the tier-1 5% penalty.
    assert_eq!(refund, deposit_amount);
    assert_eq!(token.balance(&borrower), balance_before + deposit_amount);

    // The request is consumed — a second attempt finds nothing to execute.
    assert_eq!(client.get_hardship_request(&borrower, &goal_id), None);
    let res = client.try_withdraw_hardship(&borrower, &goal_id);
    assert_eq!(res, Err(Ok(EscrowError::HardshipRequestNotFound)));
}

#[test]
fn test_unapproved_or_expired_hardship_request_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address, lending_pool));

    let goal_id = Symbol::new(&env, "house");
    client.deposit(&borrower, &goal_id, &1_000_0000000i128);

    // Never approved: execution is rejected outright.
    client.request_hardship_withdrawal(&borrower, &goal_id, &reason(&env, 0x01));
    let res = client.try_withdraw_hardship(&borrower, &goal_id);
    assert_eq!(res, Err(Ok(EscrowError::HardshipRequestNotApproved)));

    // Approving after the window has elapsed is itself rejected, and clears
    // the stale request.
    env.ledger().with_mut(|li| li.sequence_number += 120_960 + 1);
    let approve_res = client.try_approve_hardship_withdrawal(&borrower, &goal_id);
    assert_eq!(approve_res, Err(Ok(EscrowError::HardshipRequestExpired)));
    assert_eq!(client.get_hardship_request(&borrower, &goal_id), None);
}

#[test]
fn test_hardship_withdrawal_rejects_amount_over_the_configured_cap() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address, lending_pool));

    // Cap hardship payouts at 1,000 per 30-day period.
    client.set_hardship_config(&0u32, &1_000_0000000i128, &0u32);

    let goal_id = Symbol::new(&env, "house");
    client.deposit(&borrower, &goal_id, &2_000_0000000i128);

    client.request_hardship_withdrawal(&borrower, &goal_id, &reason(&env, 0x02));
    client.approve_hardship_withdrawal(&borrower, &goal_id);

    let res = client.try_withdraw_hardship(&borrower, &goal_id);
    assert_eq!(res, Err(Ok(EscrowError::HardshipAmountExceedsCap)));
}

#[test]
fn test_normal_penalty_withdrawal_path_is_unaffected_by_hardship_feature() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), lending_pool));

    let goal_id = Symbol::new(&env, "house");
    let deposit_amount = 2_000_0000000i128;
    client.deposit(&borrower, &goal_id, &deposit_amount);

    // A plain, non-hardship withdraw still pays the normal tier-1 penalty
    // (5% per base_config), exactly as it did before this feature existed —
    // no hardship request was ever filed for this goal.
    let refund = client.withdraw(&borrower, &goal_id);
    let expected_penalty = (deposit_amount * 500) / 10_000;
    assert_eq!(refund, deposit_amount - expected_penalty);
}
