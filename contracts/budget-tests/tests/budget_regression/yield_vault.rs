// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::yield_vault::{DataKey, YieldVaultContract, YieldVaultContractClient};
use budget_tests::Recorder;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env,
};

const UNIT: i128 = 10_000_000;

struct Fixture<'a> {
    client: YieldVaultContractClient<'a>,
    admin: Address,
    token: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    // `withdraw` mints simulated yield through a non-root sub-invocation.
    env.mock_all_auths_allowing_non_root_auth();
    // Long idle gaps are part of the worst case; keep entries alive across them.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 10_000_000;
        li.min_temp_entry_ttl = 10_000_000;
        li.max_entry_ttl = 10_000_000;
    });
    let admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let id = env.register(YieldVaultContract, ());
    let client = YieldVaultContractClient::new(env, &id);
    client.initialize(&admin, &token, &500);
    StellarAssetClient::new(env, &token).mint(&admin, &(1_000_000 * UNIT));
    Fixture {
        client,
        admin,
        token,
    }
}

fn funded_user(env: &Env, f: &Fixture<'_>) -> Address {
    let user = Address::generate(env);
    StellarAssetClient::new(env, &f.token).mint(&user, &(1_000_000 * UNIT));
    user
}

pub fn run(rec: &mut Recorder) {
    representative(rec);
    worst_case(rec);
}

fn representative(rec: &mut Recorder) {
    let env = Env::default();
    {
        env.mock_all_auths();
        let id = env.register(YieldVaultContract, ());
        let c = YieldVaultContractClient::new(&env, &id);
        let (admin, token) = (Address::generate(&env), Address::generate(&env));
        rec.measure("yield-vault::initialize", &env, || {
            c.initialize(&admin, &token, &500)
        });
    }

    let f = fixture(&env);
    let c = &f.client;
    let user = funded_user(&env, &f);

    rec.measure("yield-vault::deposit", &env, || {
        c.deposit(&user, &(1_000 * UNIT))
    });
    env.ledger().with_mut(|li| li.sequence_number += 1_000);
    rec.measure("yield-vault::accrue_interest", &env, || c.accrue_interest());
    rec.measure("yield-vault::batch_harvest", &env, || c.batch_harvest());
    rec.measure("yield-vault::convert_to_assets", &env, || {
        c.convert_to_assets(&(100 * UNIT))
    });
    rec.measure("yield-vault::get_shares", &env, || c.get_shares(&user));
    rec.measure("yield-vault::get_total_assets", &env, || {
        c.get_total_assets()
    });
    rec.measure("yield-vault::get_total_shares", &env, || {
        c.get_total_shares()
    });
    rec.measure("yield-vault::get_available_liquidity", &env, || {
        c.get_available_liquidity()
    });
    rec.measure("yield-vault::get_withdrawal_threshold", &env, || {
        c.get_withdrawal_threshold()
    });
    rec.measure("yield-vault::get_queue_length", &env, || {
        c.get_queue_length()
    });
    rec.measure("yield-vault::get_queued_withdrawal", &env, || {
        c.get_queued_withdrawal(&0)
    });
    rec.measure("yield-vault::add_liquidity", &env, || {
        c.add_liquidity(&f.admin, &(100 * UNIT))
    });
    rec.measure("yield-vault::withdraw", &env, || {
        c.withdraw(&user, &(100 * UNIT))
    });

    rec.measure("yield-vault::set_withdrawal_threshold", &env, || {
        c.set_withdrawal_threshold(&f.admin, &UNIT)
    });
    // Queued path: amount above the threshold waits for liquidity.
    env.as_contract(&c.address, || {
        env.storage()
            .instance()
            .set(&DataKey::AvailableLiquidity, &0i128);
    });
    rec.measure("yield-vault::request_withdrawal", &env, || {
        c.request_withdrawal(&user, &(100 * UNIT))
    });
    c.add_liquidity(&f.admin, &(1_000 * UNIT));
    rec.measure("yield-vault::process_withdrawal_queue", &env, || {
        c.process_withdrawal_queue()
    });
}

fn worst_case(rec: &mut Recorder) {
    // A long withdrawal queue settled in one call.
    let env = Env::default();
    let f = fixture(&env);
    let c = &f.client;
    c.set_withdrawal_threshold(&f.admin, &1);
    let mut users = std::vec::Vec::new();
    for _ in 0..40 {
        let u = funded_user(&env, &f);
        c.deposit(&u, &(1_000 * UNIT));
        users.push(u);
    }
    env.as_contract(&c.address, || {
        env.storage()
            .instance()
            .set(&DataKey::AvailableLiquidity, &0i128);
    });
    for u in &users {
        c.request_withdrawal(u, &(100 * UNIT));
    }
    c.add_liquidity(&f.admin, &(100_000 * UNIT));
    rec.measure("yield-vault::process_withdrawal_queue#worst", &env, || {
        c.process_withdrawal_queue()
    });

    // Interest compounded over a very long idle gap.
    env.ledger().with_mut(|li| li.sequence_number += 2_000_000);
    rec.measure("yield-vault::accrue_interest#worst", &env, || {
        c.accrue_interest()
    });
    rec.measure("yield-vault::deposit#worst", &env, || {
        c.deposit(&users[0], &(500 * UNIT))
    });
}
