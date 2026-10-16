// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::escrow::types::{BeneficiaryList, BeneficiarySplit, EscrowConfig};
use ::escrow::{EscrowContract, EscrowContractClient};
use budget_tests::Recorder;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, Symbol, Vec,
};

const MINT: i128 = 1_000_000_0000000;

fn config(
    env: &Env,
    admin: &Address,
    token: &Address,
    match_bps: u32,
    match_cap: i128,
) -> EscrowConfig {
    EscrowConfig {
        admin: admin.clone(),
        token: token.clone(),
        lending_pool: Address::generate(env),
        savings_target: 10_000_0000000,
        max_duration_ledgers: 518_400,
        early_withdrawal_penalty_bps: 500,
        min_duration_ledgers: 0,
        penalty_bps_tier1: 500,
        penalty_bps_tier2: 300,
        penalty_bps_tier3: 150,
        penalty_bps_tier4: 50,
        grace_period_ledgers: 10,
        default_penalty_bps: 1000,
        instance_bump_amount: 518_400,
        instance_lifetime_threshold: 129_600,
        persistent_bump_amount: 518_400,
        persistent_lifetime_threshold: 129_600,
        yield_vault: None,
        match_bps,
        match_cap,
        permissioned_mode: false,
    }
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    admin: Address,
    owner: Address,
}

fn fixture(env: &Env, match_bps: u32, match_cap: i128) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.max_entry_ttl = 1_000_000);
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let sac = StellarAssetClient::new(env, &token);
    sac.mint(&owner, &MINT);
    let id = env.register(EscrowContract, ());
    // Fund the contract so matching and releases have liquidity.
    sac.mint(&id, &MINT);
    let client = EscrowContractClient::new(env, &id);
    client.initialize(&config(env, &admin, &token, match_bps, match_cap));
    Fixture {
        client,
        admin,
        owner,
    }
}

fn splits(env: &Env, n: u32) -> BeneficiaryList {
    let share = 10_000 / n;
    let mut v = Vec::new(env);
    for i in 0..n {
        let bps = if i == n - 1 {
            10_000 - share * (n - 1)
        } else {
            share
        };
        v.push_back(BeneficiarySplit {
            beneficiary: Address::generate(env),
            share_bps: bps,
        });
    }
    BeneficiaryList { splits: v }
}

pub fn run(rec: &mut Recorder) {
    representative(rec);
    worst_case(rec);
}

fn representative(rec: &mut Recorder) {
    let env = Env::default();
    let f = fixture(&env, 0, 0);
    let c = &f.client;
    let goal = Symbol::new(&env, "home");
    let other = Symbol::new(&env, "car");
    let amt = 1_000_0000000i128;

    // initialize is measured on a fresh contract.
    {
        let env2 = Env::default();
        env2.mock_all_auths();
        let admin = Address::generate(&env2);
        let token = env2
            .register_stellar_asset_contract_v2(Address::generate(&env2))
            .address();
        let id = env2.register(EscrowContract, ());
        let c2 = EscrowContractClient::new(&env2, &id);
        let cfg = config(&env2, &admin, &token, 0, 0);
        rec.measure("escrow::initialize", &env2, || c2.initialize(&cfg));
    }

    rec.measure("escrow::deposit", &env, || c.deposit(&f.owner, &goal, &amt));
    rec.measure("escrow::top_up", &env, || c.top_up(&f.owner, &goal, &amt));
    rec.measure("escrow::transfer_between_goals", &env, || {
        c.transfer_between_goals(&f.owner, &goal, &other, &(amt / 2))
    });
    rec.measure("escrow::set_auto_rollover", &env, || {
        c.set_auto_rollover(&f.owner, &goal, &true)
    });

    // Beneficiaries.
    let bene = Address::generate(&env);
    rec.measure("escrow::set_beneficiary", &env, || {
        c.set_beneficiary(&f.owner, &goal, &Some(bene.clone()))
    });
    rec.measure("escrow::get_beneficiary", &env, || {
        c.get_beneficiary(&f.owner, &goal)
    });
    rec.measure("escrow::remove_beneficiary", &env, || {
        c.remove_beneficiary(&f.owner, &goal)
    });
    let list = splits(&env, 3);
    rec.measure("escrow::set_beneficiary_list", &env, || {
        c.set_beneficiary_list(&f.owner, &goal, &list)
    });
    rec.measure("escrow::get_beneficiary_list", &env, || {
        c.get_beneficiary_list(&f.owner, &goal)
    });
    rec.measure("escrow::remove_beneficiary_list", &env, || {
        c.remove_beneficiary_list(&f.owner, &goal)
    });

    // Penalty tier governance.
    rec.measure("escrow::propose_penalty_tiers", &env, || {
        c.propose_penalty_tiers(&400, &250, &120, &40)
    });
    rec.measure("escrow::get_pending_penalty_tiers", &env, || {
        c.get_pending_penalty_tiers()
    });
    rec.measure("escrow::update_penalty_tiers", &env, || {
        c.update_penalty_tiers()
    });

    // Permissioned mode.
    let member = Address::generate(&env);
    rec.measure("escrow::set_permissioned_mode", &env, || {
        c.set_permissioned_mode(&true)
    });
    rec.measure("escrow::add_to_whitelist", &env, || {
        c.add_to_whitelist(&member)
    });
    rec.measure("escrow::is_address_whitelisted", &env, || {
        c.is_address_whitelisted(&member)
    });
    rec.measure("escrow::get_permissioned_mode", &env, || {
        c.get_permissioned_mode()
    });
    rec.measure("escrow::remove_from_whitelist", &env, || {
        c.remove_from_whitelist(&member)
    });
    c.set_permissioned_mode(&false);

    // Inheritance / beneficiary claim.
    let attestor = Address::generate(&env);
    rec.measure("escrow::set_beneficiary_inactivity", &env, || {
        c.set_beneficiary_inactivity(&10)
    });
    rec.measure("escrow::get_beneficiary_inactivity", &env, || {
        c.get_beneficiary_inactivity()
    });
    let signers = Vec::from_array(&env, [attestor.clone()]);
    rec.measure("escrow::configure_beneficiary_attestors", &env, || {
        c.configure_beneficiary_attestors(&signers, &1)
    });
    c.set_beneficiary(&f.owner, &goal, &Some(bene.clone()));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);
    rec.measure("escrow::claim_as_beneficiary", &env, || {
        c.claim_as_beneficiary(&f.owner, &goal, &bene, &attestations)
    });

    // Withdraw / release on fresh goals.
    let g_withdraw = Symbol::new(&env, "wd");
    let g_release = Symbol::new(&env, "rel");
    c.deposit(&f.owner, &g_withdraw, &amt);
    c.deposit(&f.owner, &g_release, &amt);
    rec.measure("escrow::withdraw", &env, || {
        c.withdraw(&f.owner, &g_withdraw)
    });
    let recipient = Address::generate(&env);
    rec.measure("escrow::release", &env, || {
        c.release(&f.owner, &g_release, &recipient)
    });

    // Views.
    rec.measure("escrow::get_balance", &env, || {
        c.get_balance(&f.owner, &goal)
    });
    rec.measure("escrow::get_borrower_balance", &env, || {
        c.get_borrower_balance(&f.owner, &goal)
    });
    rec.measure("escrow::get_total_pooled", &env, || c.get_total_pooled());
    rec.measure("escrow::get_escrow_config", &env, || c.get_escrow_config());
    rec.measure("escrow::get_last_owner_activity", &env, || {
        c.get_last_owner_activity(&f.owner, &goal)
    });
    rec.measure("escrow::get_pending_upgrade", &env, || {
        c.get_pending_upgrade()
    });
    let _ = &f.admin;
}

fn worst_case(rec: &mut Recorder) {
    // Largest beneficiary split list (MAX_BENEFICIARY_SPLITS = 10) and the
    // O(n²) duplicate check it triggers.
    {
        let env = Env::default();
        let f = fixture(&env, 0, 0);
        let goal = Symbol::new(&env, "home");
        f.client.deposit(&f.owner, &goal, &1_000_0000000);
        let list = splits(&env, 10);
        rec.measure("escrow::set_beneficiary_list#worst", &env, || {
            f.client.set_beneficiary_list(&f.owner, &goal, &list)
        });
        rec.measure("escrow::get_beneficiary_list#worst", &env, || {
            f.client.get_beneficiary_list(&f.owner, &goal)
        });
        rec.measure("escrow::remove_beneficiary_list#worst", &env, || {
            f.client.remove_beneficiary_list(&f.owner, &goal)
        });
    }

    // Large attestor quorum: duplicate check is O(n²), claim verifies all.
    {
        let env = Env::default();
        let f = fixture(&env, 0, 0);
        let goal = Symbol::new(&env, "home");
        f.client.deposit(&f.owner, &goal, &1_000_0000000);
        let mut set = Vec::new(&env);
        for _ in 0..25 {
            set.push_back(Address::generate(&env));
        }
        rec.measure(
            "escrow::configure_beneficiary_attestors#worst",
            &env,
            || f.client.configure_beneficiary_attestors(&set, &25),
        );
        f.client.set_beneficiary_inactivity(&10);
        let bene = Address::generate(&env);
        f.client
            .set_beneficiary(&f.owner, &goal, &Some(bene.clone()));
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 10);
        rec.measure("escrow::claim_as_beneficiary#worst", &env, || {
            f.client.claim_as_beneficiary(&f.owner, &goal, &bene, &set)
        });
    }

    // Deposit that also draws on the matching reserve.
    {
        let env = Env::default();
        let f = fixture(&env, 5_000, 100_000_0000000);
        let goal = Symbol::new(&env, "home");
        rec.measure("escrow::deposit#worst", &env, || {
            f.client.deposit(&f.owner, &goal, &5_000_0000000)
        });
        rec.measure("escrow::top_up#worst", &env, || {
            f.client.top_up(&f.owner, &goal, &5_000_0000000)
        });
        let _ = &f.admin;
    }
}
