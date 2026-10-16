// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::governance::{GovernanceContract, GovernanceContractClient};
use budget_tests::Recorder;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

struct Fixture<'a> {
    client: GovernanceContractClient<'a>,
    admin: Address,
    guardian: Address,
    signers: Vec<Address>,
}

fn fixture(env: &Env, signer_count: u32, quorum_bps: u32) -> Fixture<'_> {
    env.mock_all_auths();
    let id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(env, &id);
    let admin = Address::generate(env);
    let guardian = Address::generate(env);
    let mut signers = Vec::new(env);
    for _ in 0..signer_count {
        signers.push_back(Address::generate(env));
    }
    client.initialize(&admin, &guardian, &signers, &quorum_bps);
    Fixture {
        client,
        admin,
        guardian,
        signers,
    }
}

fn evidence(env: &Env) -> Bytes {
    Bytes::from_slice(env, &[b'Q'; 46])
}

pub fn run(rec: &mut Recorder) {
    representative(rec);
    worst_case(rec);
}

fn representative(rec: &mut Recorder) {
    let env = Env::default();
    {
        env.mock_all_auths();
        let id = env.register(GovernanceContract, ());
        let c = GovernanceContractClient::new(&env, &id);
        let (admin, guardian) = (Address::generate(&env), Address::generate(&env));
        let signers = Vec::from_array(&env, [Address::generate(&env), Address::generate(&env)]);
        rec.measure("governance::initialize", &env, || {
            c.initialize(&admin, &guardian, &signers, &5_000)
        });
    }

    let f = fixture(&env, 5, 6_000);
    let c = &f.client;
    let s = |i: u32| f.signers.get(i).unwrap();

    let pid = rec.measure("governance::submit_proposal", &env, || {
        c.submit_proposal(&s(0), &1, &evidence(&env))
    });
    rec.measure("governance::vote", &env, || c.vote(&s(0), &pid));
    c.vote(&s(1), &pid);
    rec.measure("governance::vote#quorum", &env, || c.vote(&s(2), &pid));
    rec.measure("governance::is_approved", &env, || c.is_approved(&pid));
    rec.measure("governance::execute_proposal", &env, || {
        c.execute_proposal(&s(0), &pid)
    });
    rec.measure("governance::get_proposal", &env, || c.get_proposal(&pid));
    rec.measure("governance::get_config", &env, || c.get_config());
    rec.measure("governance::get_voting_power", &env, || {
        c.get_voting_power(&pid, &s(0))
    });

    let vetoed = c.submit_proposal(&s(0), &2, &evidence(&env));
    rec.measure("governance::veto", &env, || c.veto(&f.guardian, &vetoed));

    rec.measure("governance::delegate", &env, || c.delegate(&s(3), &s(4)));
    rec.measure("governance::get_delegate", &env, || c.get_delegate(&s(3)));
    rec.measure("governance::revoke_delegation", &env, || {
        c.revoke_delegation(&s(3))
    });

    let newcomer = Address::generate(&env);
    rec.measure("governance::add_signer", &env, || c.add_signer(&newcomer));
    rec.measure("governance::remove_signer", &env, || {
        c.remove_signer(&newcomer)
    });
    let _ = &f.admin;
}

fn worst_case(rec: &mut Recorder) {
    // Large committee where every non-voting signer has delegated: the power
    // snapshot taken on submit and the voter-list scans scale with signers.
    let env = Env::default();
    let f = fixture(&env, 60, 5_000);
    let c = &f.client;
    let s = |i: u32| f.signers.get(i).unwrap();
    for i in 1..30 {
        c.delegate(&s(i), &s(0));
    }
    let pid = rec.measure("governance::submit_proposal#worst", &env, || {
        c.submit_proposal(&s(0), &1, &Bytes::from_slice(&env, &[b'Q'; 512]))
    });
    for i in 30..59 {
        c.vote(&s(i), &pid);
    }
    rec.measure("governance::vote#worst", &env, || c.vote(&s(59), &pid));
    rec.measure("governance::get_voting_power#worst", &env, || {
        c.get_voting_power(&pid, &s(0))
    });
    let newcomer = Address::generate(&env);
    rec.measure("governance::add_signer#worst", &env, || {
        c.add_signer(&newcomer)
    });
    rec.measure("governance::remove_signer#worst", &env, || {
        c.remove_signer(&newcomer)
    });
    rec.measure("governance::delegate#worst", &env, || {
        c.delegate(&s(40), &s(0))
    });
    rec.measure("governance::get_config#worst", &env, || c.get_config());
    let _ = (&f.admin, &f.guardian);
}
