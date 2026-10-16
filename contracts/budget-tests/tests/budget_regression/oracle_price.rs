// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::oracle_price::{
    AggregationConfig, DeviationConfig, OraclePriceContract, OraclePriceContractClient,
};
use budget_tests::Recorder;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

fn fixture(env: &Env) -> (OraclePriceContractClient<'_>, Address) {
    env.mock_all_auths();
    let id = env.register(OraclePriceContract, ());
    let client = OraclePriceContractClient::new(env, &id);
    let admin = Address::generate(env);
    client.initialize(&admin);
    (client, admin)
}

fn at(env: &Env, ledger: u32) {
    env.ledger().set_sequence_number(ledger);
}

pub fn run(rec: &mut Recorder) {
    let env = Env::default();
    {
        env.mock_all_auths();
        let id = env.register(OraclePriceContract, ());
        let c = OraclePriceContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        rec.measure("oracle-price::initialize", &env, || c.initialize(&admin));
    }

    let (c, _admin) = fixture(&env);
    let dev = DeviationConfig {
        max_deviation_bps: 1_000_000,
        window_ledgers: 20,
    };
    rec.measure("oracle-price::set_deviation_config", &env, || {
        c.set_deviation_config(&dev)
    });
    at(&env, 1);
    rec.measure("oracle-price::update_price", &env, || c.update_price(&100));
    at(&env, 2);
    c.update_price(&110);
    rec.measure("oracle-price::get_price", &env, || c.get_price());
    rec.measure("oracle-price::is_halted", &env, || c.is_halted());
    rec.measure("oracle-price::clear_halt", &env, || c.clear_halt());

    // Multi-reporter aggregation.
    let (c2, _a) = fixture(&env);
    let reporter = Address::generate(&env);
    let agg = AggregationConfig {
        min_quorum: 1,
        max_staleness_ledgers: 100,
        max_deviation_bps: 5_000,
    };
    rec.measure("oracle-price::set_aggregation_config", &env, || {
        c2.set_aggregation_config(&agg)
    });
    rec.measure("oracle-price::add_reporter", &env, || {
        c2.add_reporter(&reporter)
    });
    rec.measure("oracle-price::submit_price", &env, || {
        c2.submit_price(&reporter, &100)
    });
    rec.measure("oracle-price::remove_reporter", &env, || {
        c2.remove_reporter(&reporter)
    });

    worst_case(rec);
}

fn worst_case(rec: &mut Recorder) {
    // Long TWAP window: every update appends to and prunes a large
    // observation list, and get_price averages all of it.
    {
        let env = Env::default();
        let (c, _a) = fixture(&env);
        c.set_deviation_config(&DeviationConfig {
            max_deviation_bps: 1_000_000,
            window_ledgers: 400,
        });
        for l in 1..=400 {
            at(&env, l);
            c.update_price(&(1_000 + l as i128));
        }
        at(&env, 401);
        rec.measure("oracle-price::update_price#worst", &env, || {
            c.update_price(&1_500)
        });
        rec.measure("oracle-price::get_price#worst", &env, || c.get_price());
    }

    // MAX_REPORTERS reporters: lookups and the median/outlier pass are O(n^2).
    {
        let env = Env::default();
        let (c, _a) = fixture(&env);
        c.set_aggregation_config(&AggregationConfig {
            min_quorum: 10,
            max_staleness_ledgers: 100,
            max_deviation_bps: 5_000,
        });
        let mut reporters = soroban_sdk::Vec::new(&env);
        for _ in 0..20 {
            let r = Address::generate(&env);
            c.add_reporter(&r);
            reporters.push_back(r);
        }
        at(&env, 5);
        for i in 0..19 {
            c.submit_price(&reporters.get(i).unwrap(), &(1_000 + i as i128));
        }
        let last = reporters.get(19).unwrap();
        rec.measure("oracle-price::submit_price#worst", &env, || {
            c.submit_price(&last, &1_019)
        });
        rec.measure("oracle-price::get_price#aggregated", &env, || c.get_price());
        rec.measure("oracle-price::remove_reporter#worst", &env, || {
            c.remove_reporter(&last)
        });
    }
}
