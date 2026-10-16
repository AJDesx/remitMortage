// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::insurance_pool::{ClaimRequest, InsurancePoolContract, InsurancePoolContractClient};
use budget_tests::Recorder;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, Vec};

struct Fixture<'a> {
    client: InsurancePoolContractClient<'a>,
    pool: Address,
    funder: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let pool = Address::generate(env);
    let funder = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let sac = StellarAssetClient::new(env, &token);
    sac.mint(&funder, &1_000_000_000);
    sac.mint(&pool, &1_000_000_000);
    let id = env.register(InsurancePoolContract, ());
    let client = InsurancePoolContractClient::new(env, &id);
    client.initialize(&admin, &token, &pool);
    Fixture {
        client,
        pool,
        funder,
    }
}

pub fn run(rec: &mut Recorder) {
    let env = Env::default();
    {
        env.mock_all_auths();
        let id = env.register(InsurancePoolContract, ());
        let c = InsurancePoolContractClient::new(&env, &id);
        let (admin, token, pool) = (
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        );
        rec.measure("insurance-pool::initialize", &env, || {
            c.initialize(&admin, &token, &pool)
        });
    }

    let f = fixture(&env);
    let c = &f.client;
    rec.measure("insurance-pool::fund", &env, || {
        c.fund(&f.funder, &100_000_000)
    });
    rec.measure("insurance-pool::record_premium", &env, || {
        c.record_premium(&f.pool, &1_000)
    });
    let recipient = Address::generate(&env);
    rec.measure("insurance-pool::claim", &env, || {
        c.claim(&recipient, &1_000)
    });
    let new_pool = Address::generate(&env);
    rec.measure("insurance-pool::set_lending_pool", &env, || {
        c.set_lending_pool(&new_pool)
    });
    c.set_lending_pool(&f.pool);

    let claims = Vec::from_array(
        &env,
        [
            ClaimRequest {
                recipient: Address::generate(&env),
                amount: 1_000,
            },
            ClaimRequest {
                recipient: Address::generate(&env),
                amount: 2_000,
            },
            ClaimRequest {
                recipient: Address::generate(&env),
                amount: 3_000,
            },
        ],
    );
    rec.measure("insurance-pool::batch_process_claims", &env, || {
        c.batch_process_claims(&claims)
    });

    rec.measure("insurance-pool::get_reserves", &env, || c.get_reserves());
    rec.measure("insurance-pool::get_total_collected", &env, || {
        c.get_total_collected()
    });
    rec.measure("insurance-pool::get_total_claimed", &env, || {
        c.get_total_claimed()
    });
    rec.measure("insurance-pool::get_admin", &env, || c.get_admin());
    rec.measure("insurance-pool::get_lending_pool", &env, || {
        c.get_lending_pool()
    });
    rec.measure("insurance-pool::quote_premium", &env, || {
        c.quote_premium(&1_000_000)
    });

    // Worst case: the maximum batch of claims in a single call.
    let env2 = Env::default();
    let f2 = fixture(&env2);
    f2.client.fund(&f2.funder, &900_000_000);
    let mut big = Vec::new(&env2);
    for _ in 0..::insurance_pool::MAX_BATCH_CLAIMS {
        big.push_back(ClaimRequest {
            recipient: Address::generate(&env2),
            amount: 1_000,
        });
    }
    rec.measure("insurance-pool::batch_process_claims#worst", &env2, || {
        f2.client.batch_process_claims(&big)
    });
}
