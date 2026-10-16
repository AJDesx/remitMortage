// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for the beneficiary-attestor threshold/signer change timelock.

#![cfg(test)]

use crate::errors::EscrowError;
use crate::types::EscrowConfig;
use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
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
        instance_bump_amount: 1_000_000u32,
        instance_lifetime_threshold: 500_000u32,
        persistent_bump_amount: 1_000_000u32,
        persistent_lifetime_threshold: 500_000u32,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    }
}

fn setup(env: &Env) -> (EscrowContractClient<'_>, Address) {
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 2_000_000;
    });

    let admin = Address::generate(env);
    let token = Address::generate(env);
    let lending_pool = Address::generate(env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    client.initialize(&base_config(admin.clone(), token, lending_pool));

    (client, admin)
}

#[test]
fn test_change_applies_immediately_when_no_delay_configured() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin) = setup(&env);
    let signer1 = Address::generate(&env);

    // Default delay is 0: existing immediate-apply behavior is preserved.
    assert_eq!(client.get_attestor_change_delay(), 0);
    client.configure_beneficiary_attestors(&soroban_sdk::vec![&env, signer1.clone()], &1);

    assert!(client.get_attestor_change_proposal().is_none());
}

#[test]
fn test_configuring_delay_turns_change_into_a_pending_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin) = setup(&env);
    let signer1 = Address::generate(&env);

    client.set_attestor_change_delay(&100u32);

    let before = env.ledger().sequence();
    client.configure_beneficiary_attestors(&soroban_sdk::vec![&env, signer1.clone()], &1);

    let pending = client.get_attestor_change_proposal().unwrap();
    assert_eq!(pending.threshold, 1);
    assert_eq!(pending.signers.len(), 1);
    assert_eq!(pending.execute_after, before + 100);

    // Applying before the timelock elapses must revert.
    let result = client.try_apply_attestor_change();
    assert_eq!(result, Err(Ok(EscrowError::UpgradeTimelockActive)));
}

#[test]
fn test_apply_succeeds_after_timelock_elapses() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin) = setup(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    client.set_attestor_change_delay(&50u32);
    client.configure_beneficiary_attestors(
        &soroban_sdk::vec![&env, signer1.clone(), signer2.clone()],
        &2,
    );

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 50);
    client.apply_attestor_change();

    assert!(client.get_attestor_change_proposal().is_none());

    // Verify the new quorum actually took effect by requiring both signers
    // for a beneficiary claim's attestation check elsewhere would need a
    // deposited goal; here we confirm via the stored config instead.
    env.as_contract(&client.address, || {
        let stored: crate::types::BeneficiaryAttestorConfig = env
            .storage()
            .instance()
            .get(&crate::types::DataKey::BeneficiaryAttestors)
            .unwrap();
        assert_eq!(stored.threshold, 2);
        assert_eq!(stored.signers.len(), 2);
    });
}

#[test]
fn test_cancel_during_timelock_prevents_activation() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin) = setup(&env);
    let signer1 = Address::generate(&env);

    client.set_attestor_change_delay(&50u32);
    client.configure_beneficiary_attestors(&soroban_sdk::vec![&env, signer1.clone()], &1);
    assert!(client.get_attestor_change_proposal().is_some());

    client.cancel_attestor_change();
    assert!(client.get_attestor_change_proposal().is_none());

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 50);
    let result = client.try_apply_attestor_change();
    assert_eq!(
        result,
        Err(Ok(EscrowError::AttestorChangeProposalNotPending))
    );
}

#[test]
fn test_cancel_with_no_pending_change_reverts() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin) = setup(&env);

    let result = client.try_cancel_attestor_change();
    assert_eq!(
        result,
        Err(Ok(EscrowError::AttestorChangeProposalNotPending))
    );
}
