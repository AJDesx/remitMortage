// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use ::multisig_validator::{Action, MultisigValidator, MultisigValidatorClient, Signer};
use budget_tests::Recorder;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, Symbol, Vec,
};

fn key(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn client(env: &Env) -> MultisigValidatorClient<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000_000;
        // Some scenarios jump millions of ledgers ahead; keep entries live.
        li.min_persistent_entry_ttl = 20_000_000;
        li.min_temp_entry_ttl = 20_000_000;
        li.max_entry_ttl = 20_000_000;
    });
    let id = env.register(MultisigValidator, ());
    MultisigValidatorClient::new(env, &id)
}

fn key_signers(env: &Env, n: u32) -> (Vec<Signer>, Vec<BytesN<32>>) {
    let mut signers = Vec::new(env);
    let mut keys = Vec::new(env);
    for i in 0..n {
        signers.push_back(Signer {
            key: key(env, i as u8 + 1),
            weight: 1,
        });
        keys.push_back(key(env, i as u8 + 1));
    }
    (signers, keys)
}

fn addresses(env: &Env, n: u32) -> Vec<Address> {
    let mut v = Vec::new(env);
    for _ in 0..n {
        v.push_back(Address::generate(env));
    }
    v
}

pub fn run(rec: &mut Recorder) {
    account_flow(rec);
    admin_flow(rec);
    worst_case(rec);
}

/// Per-account weighted-key multisig, timelock and proposal lifecycle.
fn account_flow(rec: &mut Recorder) {
    let env = Env::default();
    let c = client(&env);
    let account = Address::generate(&env);
    let (signers, keys) = key_signers(&env, 3);
    let two = Vec::from_array(&env, [key(&env, 1), key(&env, 2)]);

    rec.measure("multisig-validator::configure_account", &env, || {
        c.configure_account(&account, &signers, &2)
    });
    rec.measure("multisig-validator::get_config", &env, || {
        c.get_config(&account)
    });
    rec.measure("multisig-validator::get_threshold", &env, || {
        c.get_threshold(&account)
    });
    rec.measure("multisig-validator::total_weight", &env, || {
        c.total_weight(&account)
    });
    rec.measure("multisig-validator::tally_weight", &env, || {
        c.tally_weight(&account, &keys)
    });
    rec.measure("multisig-validator::verify_threshold", &env, || {
        c.verify_threshold(&account, &keys)
    });
    rec.measure("multisig-validator::enforce_threshold", &env, || {
        c.enforce_threshold(&account, &keys)
    });

    rec.measure("multisig-validator::configure_timelock", &env, || {
        c.configure_timelock(&account, &10)
    });
    rec.measure("multisig-validator::get_timelock", &env, || {
        c.get_timelock(&account)
    });

    let pid = key(&env, 0xAA);
    rec.measure("multisig-validator::submit_action", &env, || {
        c.submit_action(&pid, &0)
    });
    rec.measure("multisig-validator::approve_action", &env, || {
        c.approve_action(&account, &pid, &two)
    });
    rec.measure("multisig-validator::get_proposal", &env, || {
        c.get_proposal(&pid)
    });
    env.ledger().with_mut(|li| li.timestamp += 11);
    rec.measure("multisig-validator::can_execute", &env, || {
        c.can_execute(&pid)
    });
    rec.measure("multisig-validator::execute_action", &env, || {
        c.execute_action(&pid)
    });

    let actions = Vec::from_array(
        &env,
        [Action {
            action_id: key(&env, 1),
            label: Symbol::new(&env, "pause"),
        }],
    );
    rec.measure("multisig-validator::submit_proposal", &env, || {
        c.submit_proposal(&key(&env, 0xBB), &0, &actions)
    });
    rec.measure("multisig-validator::version", &env, || c.version());
}

/// Admin-managed Address signer set, rotation, slashing and decay.
fn admin_flow(rec: &mut Recorder) {
    let env = Env::default();
    let c = client(&env);
    let admin = Address::generate(&env);
    rec.measure("multisig-validator::init_admin", &env, || {
        c.init_admin(&admin)
    });
    rec.measure("multisig-validator::get_admin", &env, || c.get_admin());

    let signers = addresses(&env, 5);
    rec.measure("multisig-validator::configure_signers", &env, || {
        c.configure_signers(&signers, &3)
    });
    rec.measure("multisig-validator::get_signer_config", &env, || {
        c.get_signer_config()
    });
    rec.measure("multisig-validator::set_threshold", &env, || {
        c.set_threshold(&2)
    });
    rec.measure("multisig-validator::set_quorum_threshold", &env, || {
        c.set_quorum_threshold(&3)
    });
    rec.measure("multisig-validator::count_valid_signers", &env, || {
        c.count_valid_signers(&signers)
    });
    rec.measure("multisig-validator::verify_signatures", &env, || {
        c.verify_signatures(&signers)
    });
    rec.measure("multisig-validator::enforce_signatures", &env, || {
        c.enforce_signatures(&signers)
    });

    rec.measure("multisig-validator::set_rotation_cooldown", &env, || {
        c.set_rotation_cooldown(&10)
    });
    rec.measure("multisig-validator::get_rotation_cooldown", &env, || {
        c.get_rotation_cooldown()
    });
    rec.measure("multisig-validator::get_last_rotation_ledger", &env, || {
        c.get_last_rotation_ledger()
    });
    let newcomer = Address::generate(&env);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 20);
    rec.measure("multisig-validator::add_signer", &env, || {
        c.add_signer(&newcomer)
    });
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 20);
    rec.measure("multisig-validator::remove_signer", &env, || {
        c.remove_signer(&newcomer)
    });

    rec.measure("multisig-validator::configure_slashing", &env, || {
        c.configure_slashing(&2, &50, &3)
    });
    rec.measure("multisig-validator::get_slashing_config", &env, || {
        c.get_slashing_config()
    });
    let (s0, s1) = (signers.get(0).unwrap(), signers.get(1).unwrap());
    rec.measure("multisig-validator::cast_vote", &env, || {
        c.cast_vote(&s0, &s1)
    });
    rec.measure("multisig-validator::get_signer_vote_record", &env, || {
        c.get_signer_vote_record(&s0, &s1)
    });
    rec.measure("multisig-validator::effective_weight", &env, || {
        c.effective_weight(&s0, &s1)
    });

    let pid = key(&env, 0xAA);
    c.submit_action(&pid, &0);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 5_000_000);
    let expired = Vec::from_array(&env, [pid]);
    rec.measure("multisig-validator::mark_missed_votes", &env, || {
        c.mark_missed_votes(&s0, &expired)
    });
    rec.measure("multisig-validator::reset_signer_penalty", &env, || {
        c.reset_signer_penalty(&s1)
    });

    rec.measure("multisig-validator::configure_decay", &env, || {
        c.configure_decay(&1_000, &1_000, &1_000, &1_000)
    });
    rec.measure("multisig-validator::get_decay_config", &env, || {
        c.get_decay_config()
    });
}

fn worst_case(rec: &mut Recorder) {
    // Largest practical weighted-key set; tally and threshold checks are
    // O(presented x configured).
    {
        let env = Env::default();
        let c = client(&env);
        let account = Address::generate(&env);
        let (signers, keys) = key_signers(&env, 60);
        rec.measure("multisig-validator::configure_account#worst", &env, || {
            c.configure_account(&account, &signers, &60)
        });
        rec.measure("multisig-validator::tally_weight#worst", &env, || {
            c.tally_weight(&account, &keys)
        });
        rec.measure("multisig-validator::verify_threshold#worst", &env, || {
            c.verify_threshold(&account, &keys)
        });
        rec.measure("multisig-validator::enforce_threshold#worst", &env, || {
            c.enforce_threshold(&account, &keys)
        });
        c.configure_timelock(&account, &10);
        let pid = key(&env, 0xAA);
        c.submit_action(&pid, &0);
        rec.measure("multisig-validator::approve_action#worst", &env, || {
            c.approve_action(&account, &pid, &keys)
        });
        rec.measure("multisig-validator::get_config#worst", &env, || {
            c.get_config(&account)
        });

        // Maximum actions in one proposal (MAX_ACTIONS_PER_PROPOSAL = 10).
        let mut actions = Vec::new(&env);
        for i in 0..10u8 {
            actions.push_back(Action {
                action_id: key(&env, i + 1),
                label: Symbol::new(&env, "act"),
            });
        }
        rec.measure("multisig-validator::submit_proposal#worst", &env, || {
            c.submit_proposal(&key(&env, 0xCC), &0, &actions)
        });
    }

    // Large admin signer set with many expired proposals to penalise.
    {
        let env = Env::default();
        let c = client(&env);
        c.init_admin(&Address::generate(&env));
        let signers = addresses(&env, 50);
        rec.measure("multisig-validator::configure_signers#worst", &env, || {
            c.configure_signers(&signers, &25)
        });
        rec.measure(
            "multisig-validator::count_valid_signers#worst",
            &env,
            || c.count_valid_signers(&signers),
        );
        rec.measure("multisig-validator::verify_signatures#worst", &env, || {
            c.verify_signatures(&signers)
        });
        rec.measure("multisig-validator::enforce_signatures#worst", &env, || {
            c.enforce_signatures(&signers)
        });
        let newcomer = Address::generate(&env);
        rec.measure("multisig-validator::add_signer#worst", &env, || {
            c.add_signer(&newcomer)
        });

        let mut ids = Vec::new(&env);
        for i in 0..30u8 {
            let pid = key(&env, 100 + i);
            c.submit_action(&pid, &0);
            ids.push_back(pid);
        }
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 5_000_000);
        let first = signers.get(0).unwrap();
        rec.measure("multisig-validator::mark_missed_votes#worst", &env, || {
            c.mark_missed_votes(&first, &ids)
        });
        rec.measure("multisig-validator::get_signer_config#worst", &env, || {
            c.get_signer_config()
        });
    }
}
