// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::milestone::{MilestoneContract, MilestoneContractClient};
use budget_tests::Recorder;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Bytes, BytesN, Env, Symbol, Vec,
};

/// Minimal stand-in for the lending pool exposing the ABI the milestone
/// contract calls cross-contract (the real pool is measured separately).
mod mockpool {
    use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

    #[contracttype]
    pub enum MKey {
        Admin,
        Token,
        LoanBorrower(BytesN<32>),
    }

    #[contract]
    pub struct MockLendingPool;

    #[contractimpl]
    impl MockLendingPool {
        pub fn initialize(env: Env, admin: Address, token: Address) {
            env.storage().instance().set(&MKey::Admin, &admin);
            env.storage().instance().set(&MKey::Token, &token);
        }

        pub fn disburse(env: Env, _loan_id: BytesN<32>, recipient: Address, amount: i128) {
            let admin: Address = env.storage().instance().get(&MKey::Admin).unwrap();
            admin.require_auth();
            let token_addr: Address = env.storage().instance().get(&MKey::Token).unwrap();
            token::Client::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &recipient,
                &amount,
            );
        }

        pub fn refnd_ms(env: Env, _loan_id: BytesN<32>, _amount: i128) {
            let admin: Address = env.storage().instance().get(&MKey::Admin).unwrap();
            admin.require_auth();
        }

        pub fn set_loan_borrower(env: Env, loan_id: BytesN<32>, borrower: Address) {
            env.storage()
                .instance()
                .set(&MKey::LoanBorrower(loan_id), &borrower);
        }

        pub fn get_loan_borrower(env: Env, loan_id: BytesN<32>) -> Option<Address> {
            env.storage().instance().get(&MKey::LoanBorrower(loan_id))
        }

        pub fn chk_bgt(_env: Env, _loan_id: BytesN<32>, _new_budget: i128) {}
    }
}

const FUNDING: i128 = 1_000_000_000;
const WINDOW: u32 = 500;

struct Fixture<'a> {
    client: MilestoneContractClient<'a>,
    pool: mockpool::MockLendingPoolClient<'a>,
    token: Address,
    admin: Address,
    contractor: Address,
    approvers: Vec<Address>,
}

fn fixture(env: &Env, approver_count: u32, threshold: u32) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.max_entry_ttl = 10_000_000);
    let id = env.register(MilestoneContract, ());
    let client = MilestoneContractClient::new(env, &id);
    let pool_id = env.register(mockpool::MockLendingPool, ());
    let pool = mockpool::MockLendingPoolClient::new(env, &pool_id);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    StellarAssetClient::new(env, &token).mint(&pool_id, &FUNDING);
    pool.initialize(&id, &token);

    let admin = Address::generate(env);
    let contractor = Address::generate(env);
    let mut approvers = Vec::new(env);
    for _ in 0..approver_count {
        approvers.push_back(Address::generate(env));
    }
    client.initialize(&admin, &token, &pool_id, &approvers, &threshold);
    Fixture {
        client,
        pool,
        token,
        admin,
        contractor,
        approvers,
    }
}

fn bytes32(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn cid(env: &Env) -> Bytes {
    let mut raw = [b'x'; 46];
    raw[0] = b'Q';
    raw[1] = b'm';
    Bytes::from_slice(env, &raw)
}

fn propose(env: &Env, f: &Fixture<'_>, n: u8, amount: i128) -> BytesN<32> {
    let pid = bytes32(env, n);
    f.client.propose_milestone(
        &f.contractor,
        &pid,
        &bytes32(env, 200),
        &amount,
        &bytes32(env, 9),
        &cid(env),
    );
    pid
}

fn approve_all(f: &Fixture<'_>, pid: &BytesN<32>, count: u32) {
    for i in 0..count {
        f.client
            .approve_milestone(&f.approvers.get(i).unwrap(), pid);
    }
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

pub fn run(rec: &mut Recorder) {
    representative(rec);
    arbitration(rec);
    worst_case(rec);
}

fn representative(rec: &mut Recorder) {
    let env = Env::default();
    let f = fixture(&env, 3, 2);
    let c = &f.client;
    let a0 = f.approvers.get(0).unwrap();
    let a1 = f.approvers.get(1).unwrap();

    // initialize on a fresh contract.
    {
        let env2 = Env::default();
        env2.mock_all_auths();
        let id = env2.register(MilestoneContract, ());
        let c2 = MilestoneContractClient::new(&env2, &id);
        let (admin, token, pool) = (
            Address::generate(&env2),
            Address::generate(&env2),
            Address::generate(&env2),
        );
        let approvers =
            Vec::from_array(&env2, [Address::generate(&env2), Address::generate(&env2)]);
        rec.measure("milestone::initialize", &env2, || {
            c2.initialize(&admin, &token, &pool, &approvers, &2)
        });
    }

    // Propose / approve / release.
    let pid = bytes32(&env, 1);
    rec.measure("milestone::propose_milestone", &env, || {
        c.propose_milestone(
            &f.contractor,
            &pid,
            &bytes32(&env, 200),
            &1_000,
            &bytes32(&env, 9),
            &cid(&env),
        )
    });
    rec.measure("milestone::approve_milestone", &env, || {
        c.approve_milestone(&a0, &pid)
    });
    rec.measure("milestone::approve_milestone#threshold", &env, || {
        c.approve_milestone(&a1, &pid)
    });
    rec.measure("milestone::get_milestone", &env, || c.get_milestone(&pid));

    rec.measure("milestone::set_min_delay_ledgers", &env, || {
        c.set_min_delay_ledgers(&f.admin, &5)
    });
    advance(&env, 10);
    rec.measure("milestone::release_milestone", &env, || {
        c.release_milestone(&pid)
    });

    // Partial disbursement.
    let part = propose(&env, &f, 2, 1_000);
    approve_all(&f, &part, 2);
    advance(&env, 10);
    rec.measure("milestone::partially_approve_milestone", &env, || {
        c.partially_approve_milestone(&part, &400)
    });
    rec.measure("milestone::get_released_amount", &env, || {
        c.get_released_amount(&part)
    });
    rec.measure("milestone::get_remaining_amount", &env, || {
        c.get_remaining_amount(&part)
    });

    // Rejection and resubmission, deadline.
    let rej = propose(&env, &f, 3, 1_000);
    let deadline = env.ledger().sequence() + 5_000;
    rec.measure("milestone::set_milestone_deadline", &env, || {
        c.set_milestone_deadline(&f.contractor, &rej, &deadline)
    });
    rec.measure("milestone::reject_milestone", &env, || {
        c.reject_milestone(&a0, &rej)
    });
    rec.measure("milestone::resubmit_milestone", &env, || {
        c.resubmit_milestone(&f.contractor, &rej, &bytes32(&env, 10), &cid(&env))
    });

    // Budget change.
    let bud = propose(&env, &f, 4, 1_000);
    let ms = Symbol::new(&env, "ms1");
    rec.measure("milestone::propose_milestone_budget_change", &env, || {
        c.propose_milestone_budget_change(&ms, &bud, &2_000)
    });
    rec.measure("milestone::vote_budget_change", &env, || {
        c.vote_budget_change(&a0, &ms)
    });
    rec.measure("milestone::vote_budget_change#threshold", &env, || {
        c.vote_budget_change(&a1, &ms)
    });

    // Governance dispute of an approved milestone.
    let dis = propose(&env, &f, 5, 1_000);
    approve_all(&f, &dis, 2);
    rec.measure("milestone::dispute_milestone", &env, || {
        c.dispute_milestone(&a0, &dis)
    });

    // Performance bonus pool.
    let funder = Address::generate(&env);
    StellarAssetClient::new(&env, &f.token).mint(&funder, &10_000);
    rec.measure("milestone::set_performance_bonus_bps", &env, || {
        c.set_performance_bonus_bps(&f.admin, &500)
    });
    rec.measure("milestone::fund_bonus_pool", &env, || {
        c.fund_bonus_pool(&funder, &5_000)
    });
    rec.measure("milestone::get_bonus_pool_balance", &env, || {
        c.get_bonus_pool_balance()
    });
    rec.measure("milestone::version", &env, || c.version());
    let _ = &f.pool;
}

fn arbitration(rec: &mut Recorder) {
    let env = Env::default();
    let f = fixture(&env, 1, 1);
    let c = &f.client;
    let borrower = Address::generate(&env);
    f.pool.set_loan_borrower(&bytes32(&env, 200), &borrower);

    let mut arbitrators = Vec::new(&env);
    for _ in 0..3 {
        arbitrators.push_back(Address::generate(&env));
    }
    rec.measure("milestone::set_arbitration_config", &env, || {
        c.set_arbitration_config(&f.admin, &arbitrators, &2, &WINDOW)
    });
    rec.measure("milestone::get_arbitration_config", &env, || {
        c.get_arbitration_config()
    });

    let pid = propose(&env, &f, 1, 1_000);
    approve_all(&f, &pid, 1);
    rec.measure("milestone::raise_dispute", &env, || {
        c.raise_dispute(&borrower, &pid)
    });
    rec.measure("milestone::get_dispute", &env, || c.get_dispute(&pid));
    rec.measure("milestone::vote_dispute", &env, || {
        c.vote_dispute(&arbitrators.get(0).unwrap(), &pid, &true)
    });

    let expiring = propose(&env, &f, 2, 1_000);
    approve_all(&f, &expiring, 1);
    c.raise_dispute(&borrower, &expiring);
    advance(&env, WINDOW + 1);
    rec.measure("milestone::resolve_expired_dispute", &env, || {
        c.resolve_expired_dispute(&expiring)
    });
}

fn worst_case(rec: &mut Recorder) {
    // Large approver set: membership checks and vote tallies scale with it.
    let env = Env::default();
    let f = fixture(&env, 40, 40);
    let c = &f.client;
    let pid = propose(&env, &f, 1, 1_000);
    approve_all(&f, &pid, 39);
    let last = f.approvers.get(39).unwrap();
    rec.measure("milestone::approve_milestone#worst", &env, || {
        c.approve_milestone(&last, &pid)
    });

    let ms = Symbol::new(&env, "ms1");
    let bud = propose(&env, &f, 2, 1_000);
    c.propose_milestone_budget_change(&ms, &bud, &2_000);
    for i in 0..39 {
        c.vote_budget_change(&f.approvers.get(i).unwrap(), &ms);
    }
    rec.measure("milestone::vote_budget_change#worst", &env, || {
        c.vote_budget_change(&last, &ms)
    });

    // Large arbitration panel.
    let env2 = Env::default();
    let f2 = fixture(&env2, 1, 1);
    let mut panel = Vec::new(&env2);
    for _ in 0..30 {
        panel.push_back(Address::generate(&env2));
    }
    rec.measure("milestone::set_arbitration_config#worst", &env2, || {
        f2.client
            .set_arbitration_config(&f2.admin, &panel, &16, &WINDOW)
    });
    let borrower = Address::generate(&env2);
    f2.pool.set_loan_borrower(&bytes32(&env2, 200), &borrower);
    let p2 = propose(&env2, &f2, 1, 1_000);
    approve_all(&f2, &p2, 1);
    f2.client.raise_dispute(&borrower, &p2);
    for i in 0..15 {
        f2.client.vote_dispute(&panel.get(i).unwrap(), &p2, &true);
    }
    rec.measure("milestone::vote_dispute#worst", &env2, || {
        f2.client.vote_dispute(&panel.get(15).unwrap(), &p2, &true)
    });
}
