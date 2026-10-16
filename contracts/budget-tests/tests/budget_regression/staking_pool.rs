// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::staking_pool::{StakingPoolContract, StakingPoolContractClient};
use budget_tests::Recorder;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, Vec};

const UNIT: i128 = 10_000_000;

fn fixture(env: &Env) -> StakingPoolContractClient<'_> {
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register(StakingPoolContract, ());
    let client = StakingPoolContractClient::new(env, &id);
    client.initialize(&Address::generate(env));
    client
}

fn new_token(env: &Env, holders: &[&Address]) -> Address {
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let sac = StellarAssetClient::new(env, &token);
    for h in holders {
        sac.mint(h, &(1_000_000 * UNIT));
    }
    token
}

pub fn run(rec: &mut Recorder) {
    representative(rec);
    worst_case(rec);
}

fn representative(rec: &mut Recorder) {
    let env = Env::default();
    {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register(StakingPoolContract, ());
        let c = StakingPoolContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        rec.measure("staking-pool::initialize", &env, || c.initialize(&admin));
    }

    let c = fixture(&env);
    let staker = Address::generate(&env);
    let funder = Address::generate(&env);
    let token = new_token(&env, &[&staker, &funder]);
    let reward = new_token(&env, &[&funder]);

    rec.measure("staking-pool::add_token", &env, || {
        c.add_token(&token, &500)
    });
    c.add_token(&reward, &300);
    rec.measure("staking-pool::set_token_apy", &env, || {
        c.set_token_apy(&token, &700)
    });
    rec.measure("staking-pool::stake", &env, || {
        c.stake(&staker, &token, &(100 * UNIT))
    });
    rec.measure("staking-pool::distribute_rewards", &env, || {
        c.distribute_rewards(&funder, &reward, &(10 * UNIT))
    });
    rec.measure("staking-pool::claim_rewards", &env, || {
        c.claim_rewards(&staker)
    });
    rec.measure("staking-pool::preview_yield_waterfall", &env, || {
        c.preview_yield_waterfall(&(10 * UNIT))
    });
    rec.measure("staking-pool::get_supported_tokens", &env, || {
        c.get_supported_tokens()
    });
    rec.measure("staking-pool::get_shares", &env, || c.get_shares(&staker));
    rec.measure("staking-pool::get_stake_balance", &env, || {
        c.get_stake_balance(&staker, &token)
    });
    rec.measure("staking-pool::get_total_shares", &env, || {
        c.get_total_shares()
    });
    rec.measure("staking-pool::get_token_info", &env, || {
        c.get_token_info(&token)
    });
    rec.measure("staking-pool::get_accumulated_rewards", &env, || {
        c.get_accumulated_rewards(&reward)
    });
    rec.measure("staking-pool::version", &env, || c.version());
    let shares = c.get_shares(&staker);
    rec.measure("staking-pool::unstake", &env, || {
        c.unstake(&staker, &(shares / 2))
    });
    rec.measure("staking-pool::remove_token", &env, || {
        c.remove_token(&reward)
    });
}

fn worst_case(rec: &mut Recorder) {
    // Many supported tokens: unstake, distribute, claim and the waterfall
    // preview all iterate every token.
    let env = Env::default();
    let c = fixture(&env);
    let staker = Address::generate(&env);
    let funder = Address::generate(&env);
    let mut tokens = Vec::new(&env);
    for i in 0..25u32 {
        let t = new_token(&env, &[&staker, &funder]);
        c.add_token(&t, &(100 + i));
        c.stake(&staker, &t, &(100 * UNIT));
        tokens.push_back(t);
    }
    let first = tokens.get(0).unwrap();
    rec.measure("staking-pool::distribute_rewards#worst", &env, || {
        c.distribute_rewards(&funder, &first, &(10 * UNIT))
    });
    rec.measure("staking-pool::claim_rewards#worst", &env, || {
        c.claim_rewards(&staker)
    });
    rec.measure("staking-pool::preview_yield_waterfall#worst", &env, || {
        c.preview_yield_waterfall(&(10 * UNIT))
    });
    rec.measure("staking-pool::get_supported_tokens#worst", &env, || {
        c.get_supported_tokens()
    });
    rec.measure("staking-pool::stake#worst", &env, || {
        c.stake(&staker, &first, &(100 * UNIT))
    });
    let shares = c.get_shares(&staker);
    rec.measure("staking-pool::unstake#worst", &env, || {
        c.unstake(&staker, &(shares / 4))
    });
}
