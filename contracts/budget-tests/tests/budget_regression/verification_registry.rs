// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::verification_registry::{VerificationRegistryContract, VerificationRegistryContractClient};
use budget_tests::Recorder;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

struct Fixture<'a> {
    client: VerificationRegistryContractClient<'a>,
    pool: Address,
    reviewer: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 20_000_000;
        li.max_entry_ttl = 20_000_000;
    });
    let id = env.register(VerificationRegistryContract, ());
    let client = VerificationRegistryContractClient::new(env, &id);
    client.initialize(&Address::generate(env));
    let pool = Address::generate(env);
    let reviewer = Address::generate(env);
    client.set_lending_pool(&pool);
    client.set_reviewer(&reviewer);
    Fixture {
        client,
        pool,
        reviewer,
    }
}

fn hash(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

pub fn run(rec: &mut Recorder) {
    let env = Env::default();
    {
        env.mock_all_auths();
        let id = env.register(VerificationRegistryContract, ());
        let c = VerificationRegistryContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        rec.measure("verification-registry::initialize", &env, || {
            c.initialize(&admin)
        });
    }

    let f = fixture(&env);
    let c = &f.client;
    let borrower = Address::generate(&env);

    rec.measure("verification-registry::register_verification", &env, || {
        c.register_verification(&borrower, &hash(&env, 1), &1_000_000, &85)
    });
    rec.measure("verification-registry::is_verified", &env, || {
        c.is_verified(&borrower)
    });
    rec.measure("verification-registry::get_verification", &env, || {
        c.get_verification(&borrower)
    });
    rec.measure("verification-registry::get_score", &env, || {
        c.get_score(&borrower)
    });
    rec.measure("verification-registry::get_raw_score", &env, || {
        c.get_raw_score(&borrower)
    });
    rec.measure("verification-registry::get_score_decay", &env, || {
        c.get_score_decay(&borrower)
    });
    rec.measure(
        "verification-registry::get_decay_start_ledger",
        &env,
        || c.get_decay_start_ledger(&borrower),
    );
    rec.measure("verification-registry::set_decay_config", &env, || {
        c.set_decay_config(&10_000, &5, &1_000, &20)
    });
    rec.measure("verification-registry::get_decay_config", &env, || {
        c.get_decay_config()
    });
    rec.measure("verification-registry::set_rate_limits", &env, || {
        c.set_rate_limits(&1_800, &200)
    });
    rec.measure("verification-registry::set_rate_config", &env, || {
        c.set_rate_config(&400, &600, &900, &1_200)
    });
    rec.measure("verification-registry::get_rate_config", &env, || {
        c.get_rate_config()
    });
    rec.measure("verification-registry::get_rate_cap", &env, || {
        c.get_rate_cap()
    });
    rec.measure("verification-registry::get_rate_floor", &env, || {
        c.get_rate_floor()
    });
    rec.measure("verification-registry::get_borrower_rate", &env, || {
        c.get_borrower_rate(&borrower)
    });
    rec.measure("verification-registry::version", &env, || c.version());

    let pool = f.pool.clone();
    rec.measure("verification-registry::set_lending_pool", &env, || {
        c.set_lending_pool(&pool)
    });
    let reviewer = f.reviewer.clone();
    rec.measure("verification-registry::set_reviewer", &env, || {
        c.set_reviewer(&reviewer)
    });
    rec.measure(
        "verification-registry::record_repayment_status",
        &env,
        || c.record_repayment_status(&borrower, &true),
    );
    rec.measure("verification-registry::get_risk_profile", &env, || {
        c.get_risk_profile(&borrower)
    });
    rec.measure("verification-registry::appeal_score", &env, || {
        c.appeal_score(&borrower)
    });
    rec.measure("verification-registry::get_appeal", &env, || {
        c.get_appeal(&borrower)
    });
    rec.measure("verification-registry::resolve_appeal", &env, || {
        c.resolve_appeal(&borrower, &90)
    });

    let new_admin = Address::generate(&env);
    rec.measure("verification-registry::propose_new_admin", &env, || {
        c.propose_new_admin(&new_admin)
    });
    rec.measure("verification-registry::accept_admin", &env, || {
        c.accept_admin()
    });

    worst_case(rec);
}

fn worst_case(rec: &mut Recorder) {
    // Score decay after a very long dormant period with a long repayment
    // history behind the borrower.
    let env = Env::default();
    let f = fixture(&env);
    let c = &f.client;
    let borrower = Address::generate(&env);
    c.register_verification(&borrower, &hash(&env, 1), &10_000_000, &100);
    for i in 0..60 {
        c.record_repayment_status(&borrower, &(i % 3 != 0));
    }
    env.ledger().with_mut(|li| li.sequence_number += 5_000_000);
    rec.measure("verification-registry::get_score#worst", &env, || {
        c.get_score(&borrower)
    });
    rec.measure(
        "verification-registry::get_borrower_rate#worst",
        &env,
        || c.get_borrower_rate(&borrower),
    );
    rec.measure(
        "verification-registry::record_repayment_status#worst",
        &env,
        || c.record_repayment_status(&borrower, &false),
    );
    rec.measure(
        "verification-registry::get_risk_profile#worst",
        &env,
        || c.get_risk_profile(&borrower),
    );
    let _ = &f.reviewer;
}
