// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Resource-budget regression harness for the Soroban contracts.
//!
//! Scenario tests call each public entry point through [`Recorder::measure`],
//! which resets the host budget, runs the call and records the CPU
//! instructions and memory it consumed. [`Recorder::finish`] then
//!
//! * prints a per-function budget table (with headroom against the network
//!   limits),
//! * compares every measurement with `budget-baselines.json` and fails when
//!   usage grows past the configured tolerance,
//! * fails when any measurement approaches the network limit, and
//! * fails when a public `#[contractimpl]` function has neither a measurement
//!   nor an exemption in `budget-config.json`.
//!
//! Re-record the baselines on purpose with `BUDGET_UPDATE=1`. See
//! `docs/CONTRACT_BUDGET_REGRESSION.md`.
//!
//! Keys are `contract::function` for the representative input and
//! `contract::function#worst` (or any `#label`) for worst-case inputs.
//! Costs come from native (non-Wasm) execution, so absolute numbers are lower
//! than on-chain; the baselines track *relative* change.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use soroban_sdk::Env;

const BASELINES_FILE: &str = "budget-baselines.json";
const CONFIG_FILE: &str = "budget-config.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    pub cpu: u64,
    pub mem: u64,
}

#[derive(Debug)]
pub struct Config {
    /// Allowed growth over baseline, in percent.
    pub tolerance_pct: u64,
    /// Growth below these absolute amounts is ignored (tiny functions).
    pub min_abs_cpu: u64,
    pub min_abs_mem: u64,
    /// Soroban per-transaction limits.
    pub limit_cpu: u64,
    pub limit_mem: u64,
    /// Percent of the limit at which a row is flagged.
    pub warn_pct: u64,
    /// Percent of the limit at which a row fails.
    pub fail_pct: u64,
    /// `(pattern, reason)`; a trailing `*` matches by prefix.
    pub exemptions: Vec<(String, String)>,
    /// Exact keys that are known to exceed the fail threshold and are accepted
    /// (with a reason) until the contract is fixed. They still go through the
    /// baseline regression check.
    pub limit_exceptions: Vec<(String, String)>,
}

impl Config {
    pub fn load() -> Self {
        let v = read_json(&crate_path(CONFIG_FILE));
        let n = |path: &[&str]| {
            let mut cur = &v;
            for p in path {
                cur = &cur[*p];
            }
            cur.as_u64()
                .unwrap_or_else(|| panic!("{CONFIG_FILE}: missing number at {path:?}"))
        };
        let pairs = |name: &str| -> Vec<(String, String)> {
            v[name]
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(k, r)| (k.clone(), r.as_str().unwrap_or("").to_string()))
                        .collect()
                })
                .unwrap_or_default()
        };
        let exemptions = pairs("exemptions");
        let limit_exceptions = pairs("limit_exceptions");
        Config {
            tolerance_pct: n(&["tolerance_pct"]),
            min_abs_cpu: n(&["min_abs_cpu"]),
            min_abs_mem: n(&["min_abs_mem"]),
            limit_cpu: n(&["network_limits", "cpu_instructions"]),
            limit_mem: n(&["network_limits", "memory_bytes"]),
            warn_pct: n(&["warn_pct"]),
            fail_pct: n(&["fail_pct"]),
            exemptions,
            limit_exceptions,
        }
    }

    fn exemption_for(&self, key: &str) -> Option<&str> {
        self.exemptions.iter().find_map(|(pat, reason)| {
            let hit = match pat.strip_suffix('*') {
                Some(prefix) => key.starts_with(prefix),
                None => pat == key,
            };
            hit.then_some(reason.as_str())
        })
    }
}

#[derive(Default)]
pub struct Recorder {
    entries: BTreeMap<String, Usage>,
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `f` against a freshly reset, unlimited budget and record what it
    /// consumed under `key`. If the key was recorded before, the larger value
    /// is kept.
    pub fn measure<R>(&mut self, key: &str, env: &Env, f: impl FnOnce() -> R) -> R {
        let mut budget = env.cost_estimate().budget();
        budget.reset_unlimited();
        let out = f();
        let usage = Usage {
            cpu: budget.cpu_instruction_cost(),
            mem: budget.memory_bytes_cost(),
        };
        self.entries
            .entry(key.to_string())
            .and_modify(|u| {
                u.cpu = u.cpu.max(usage.cpu);
                u.mem = u.mem.max(usage.mem);
            })
            .or_insert(usage);
        out
    }

    pub fn entries(&self) -> &BTreeMap<String, Usage> {
        &self.entries
    }

    /// Print the table, then either rewrite the baselines (`BUDGET_UPDATE=1`)
    /// or compare against them and panic with every problem found.
    pub fn finish(self, contracts: &[&str]) {
        let config = Config::load();
        let baselines = load_baselines();
        let table = render_table(&self.entries, &baselines, &config);
        println!("{table}");

        if std::env::var("BUDGET_UPDATE")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            let limit_failures = limit_problems(&self.entries, &config);
            write_baselines(&self.entries);
            println!("BUDGET_UPDATE=1: wrote {}", baselines_path().display());
            assert!(limit_failures.is_empty(), "{}", limit_failures.join("\n"));
            return;
        }

        let mut problems = compare(&self.entries, &baselines, &config);
        problems.extend(limit_problems(&self.entries, &config));
        problems.extend(coverage_problems(&self.entries, &config, contracts));
        assert!(
            problems.is_empty(),
            "contract budget regression:\n  - {}\n\nIf the change is intentional, re-record with \
             `BUDGET_UPDATE=1 cargo test -p budget-tests -- --nocapture` and commit \
             budget-baselines.json (see docs/CONTRACT_BUDGET_REGRESSION.md).",
            problems.join("\n  - ")
        );
    }
}

// ── comparison ──────────────────────────────────────────────────────────

fn exceeds(current: u64, baseline: u64, tolerance_pct: u64, min_abs: u64) -> bool {
    let allowed = baseline + baseline * tolerance_pct / 100;
    current > allowed && current - baseline > min_abs
}

pub fn compare(
    entries: &BTreeMap<String, Usage>,
    baselines: &BTreeMap<String, Usage>,
    config: &Config,
) -> Vec<String> {
    let mut problems = Vec::new();
    for (key, now) in entries {
        match baselines.get(key) {
            None => problems.push(format!(
                "{key}: no recorded baseline (cpu {}, mem {}); record one with BUDGET_UPDATE=1",
                now.cpu, now.mem
            )),
            Some(base) => {
                if exceeds(now.cpu, base.cpu, config.tolerance_pct, config.min_abs_cpu) {
                    problems.push(format!(
                        "{key}: CPU {} -> {} ({:+.1}%, tolerance {}%)",
                        base.cpu,
                        now.cpu,
                        pct_change(base.cpu, now.cpu),
                        config.tolerance_pct
                    ));
                }
                if exceeds(now.mem, base.mem, config.tolerance_pct, config.min_abs_mem) {
                    problems.push(format!(
                        "{key}: memory {} -> {} bytes ({:+.1}%, tolerance {}%)",
                        base.mem,
                        now.mem,
                        pct_change(base.mem, now.mem),
                        config.tolerance_pct
                    ));
                }
            }
        }
    }
    for key in baselines.keys() {
        if !entries.contains_key(key) {
            problems.push(format!(
                "{key}: has a baseline but was not measured (scenario removed? re-record with BUDGET_UPDATE=1)"
            ));
        }
    }
    problems
}

pub fn limit_problems(entries: &BTreeMap<String, Usage>, config: &Config) -> Vec<String> {
    let mut problems = Vec::new();
    for (key, u) in entries {
        if config.limit_exceptions.iter().any(|(k, _)| k == key) {
            continue;
        }
        let cpu = u.cpu as f64 / config.limit_cpu as f64 * 100.0;
        let mem = u.mem as f64 / config.limit_mem as f64 * 100.0;
        if cpu >= config.fail_pct as f64 {
            problems.push(format!(
                "{key}: CPU uses {cpu:.1}% of the network limit (fails at {}%)",
                config.fail_pct
            ));
        }
        if mem >= config.fail_pct as f64 {
            problems.push(format!(
                "{key}: memory uses {mem:.1}% of the network limit (fails at {}%)",
                config.fail_pct
            ));
        }
    }
    problems
}

fn pct_change(base: u64, now: u64) -> f64 {
    if base == 0 {
        return 0.0;
    }
    (now as f64 - base as f64) / base as f64 * 100.0
}

// ── coverage of public entry points ─────────────────────────────────────

/// Public function names defined inside `#[contractimpl]` blocks of a source
/// file.
pub fn public_functions(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending_attr = false;
    let mut in_impl = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed == "#[contractimpl]" {
            pending_attr = true;
            continue;
        }
        if pending_attr && line.starts_with("impl") {
            in_impl = true;
            pending_attr = false;
            continue;
        }
        if in_impl && line.starts_with('}') {
            in_impl = false;
            continue;
        }
        if in_impl {
            if let Some(rest) = line.strip_prefix("    pub fn ") {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    out.push(name);
                }
            }
        }
    }
    out
}

pub fn coverage_problems(
    entries: &BTreeMap<String, Usage>,
    config: &Config,
    contracts: &[&str],
) -> Vec<String> {
    let measured: BTreeSet<&str> = entries
        .keys()
        .map(|k| k.split('#').next().unwrap_or(k))
        .collect();
    let mut problems = Vec::new();
    for contract in contracts {
        let path = crate_path(&format!("../{contract}/src/lib.rs"));
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        for func in public_functions(&source) {
            let key = format!("{contract}::{func}");
            if !measured.contains(key.as_str()) && config.exemption_for(&key).is_none() {
                problems.push(format!(
                    "{key}: public entry point has no budget scenario and no exemption in {CONFIG_FILE}"
                ));
            }
        }
    }
    problems
}

// ── output ──────────────────────────────────────────────────────────────

pub fn render_table(
    entries: &BTreeMap<String, Usage>,
    baselines: &BTreeMap<String, Usage>,
    config: &Config,
) -> String {
    let width = entries.keys().map(|k| k.len()).max().unwrap_or(10).max(10);
    let mut out = String::new();
    out.push_str(&format!(
        "\nCONTRACT RESOURCE BUDGET (native estimate; limits: {} CPU insns, {} bytes)\n",
        config.limit_cpu, config.limit_mem
    ));
    out.push_str(&format!(
        "{:<width$}  {:>13}  {:>9}  {:>11}  {:>8}  {:>8}  {}\n",
        "function", "cpu_insns", "d_cpu", "mem_bytes", "cpu_lim", "mem_lim", "status"
    ));
    out.push_str(&format!("{}\n", "-".repeat(width + 72)));
    for (key, u) in entries {
        let delta = match baselines.get(key) {
            Some(b) => format!("{:+.1}%", pct_change(b.cpu, u.cpu)),
            None => "new".to_string(),
        };
        let cpu_lim = u.cpu as f64 / config.limit_cpu as f64 * 100.0;
        let mem_lim = u.mem as f64 / config.limit_mem as f64 * 100.0;
        let accepted = config.limit_exceptions.iter().any(|(k, _)| k == key);
        let status = if cpu_lim >= config.fail_pct as f64 || mem_lim >= config.fail_pct as f64 {
            if accepted {
                "OVER LIMIT (accepted exception)"
            } else {
                "FAIL (near limit)"
            }
        } else if cpu_lim >= config.warn_pct as f64 || mem_lim >= config.warn_pct as f64 {
            "WARN"
        } else {
            "ok"
        };
        out.push_str(&format!(
            "{key:<width$}  {:>13}  {delta:>9}  {:>11}  {:>7.2}%  {:>7.2}%  {status}\n",
            u.cpu, u.mem, cpu_lim, mem_lim
        ));
    }
    out
}

// ── files ───────────────────────────────────────────────────────────────

fn crate_path(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn baselines_path() -> PathBuf {
    crate_path(BASELINES_FILE)
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("invalid JSON in {}: {e}", path.display()))
}

pub fn load_baselines() -> BTreeMap<String, Usage> {
    let path = baselines_path();
    if !path.exists() {
        return BTreeMap::new();
    }
    let v = read_json(&path);
    v["entries"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, e)| {
                    (
                        k.clone(),
                        Usage {
                            cpu: e["cpu"].as_u64().unwrap_or(0),
                            mem: e["mem"].as_u64().unwrap_or(0),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Writes one line per entry, sorted, so baseline diffs review cleanly.
fn write_baselines(entries: &BTreeMap<String, Usage>) {
    let mut out = String::from("{\n");
    out.push_str(
        "  \"_comment\": \"Recorded by `BUDGET_UPDATE=1 cargo test -p budget-tests -- --nocapture`. Native (non-Wasm) estimates; see docs/CONTRACT_BUDGET_REGRESSION.md.\",\n",
    );
    out.push_str("  \"entries\": {\n");
    let last = entries.len().saturating_sub(1);
    for (i, (key, u)) in entries.iter().enumerate() {
        out.push_str(&format!(
            "    \"{key}\": {{ \"cpu\": {}, \"mem\": {} }}{}\n",
            u.cpu,
            u.mem,
            if i == last { "" } else { "," }
        ));
    }
    out.push_str("  }\n}\n");
    std::fs::write(baselines_path(), out).expect("write baselines");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            tolerance_pct: 10,
            min_abs_cpu: 1_000,
            min_abs_mem: 100,
            limit_cpu: 100_000_000,
            limit_mem: 41_943_040,
            warn_pct: 50,
            fail_pct: 80,
            exemptions: vec![("c::get_*".into(), "getter".into())],
            limit_exceptions: vec![("c::known".into(), "tracked".into())],
        }
    }

    fn one(key: &str, cpu: u64, mem: u64) -> BTreeMap<String, Usage> {
        BTreeMap::from([(key.to_string(), Usage { cpu, mem })])
    }

    #[test]
    fn within_tolerance_passes() {
        let p = compare(
            &one("c::f", 109_000, 10_900),
            &one("c::f", 100_000, 10_000),
            &cfg(),
        );
        assert!(p.is_empty(), "{p:?}");
    }

    #[test]
    fn growth_past_tolerance_fails_for_cpu_and_memory() {
        let p = compare(
            &one("c::f", 120_000, 12_000),
            &one("c::f", 100_000, 10_000),
            &cfg(),
        );
        assert_eq!(p.len(), 2, "{p:?}");
    }

    #[test]
    fn tiny_absolute_growth_is_ignored() {
        let p = compare(&one("c::f", 1_500, 50), &one("c::f", 1_000, 40), &cfg());
        assert!(p.is_empty(), "{p:?}");
    }

    #[test]
    fn improvements_do_not_fail() {
        let p = compare(
            &one("c::f", 50_000, 5_000),
            &one("c::f", 100_000, 10_000),
            &cfg(),
        );
        assert!(p.is_empty(), "{p:?}");
    }

    #[test]
    fn missing_baseline_and_stale_baseline_are_reported() {
        let new = compare(&one("c::new", 1, 1), &BTreeMap::new(), &cfg());
        assert!(new[0].contains("no recorded baseline"));
        let stale = compare(&BTreeMap::new(), &one("c::old", 1, 1), &cfg());
        assert!(stale[0].contains("not measured"));
    }

    #[test]
    fn approaching_the_network_limit_fails() {
        let p = limit_problems(&one("c::big", 85_000_000, 1), &cfg());
        assert_eq!(p.len(), 1);
        assert!(limit_problems(&one("c::ok", 79_000_000, 1), &cfg()).is_empty());
    }

    #[test]
    fn accepted_limit_exceptions_are_not_reported() {
        assert!(limit_problems(&one("c::known", 150_000_000, 1), &cfg()).is_empty());
    }

    #[test]
    fn extracts_only_contractimpl_public_functions() {
        let src = "\
pub struct C;
impl C {
    pub fn helper() {}
}
#[contractimpl]
impl C {
    pub fn alpha(env: Env) {}
    pub fn beta_2(
        env: Env,
    ) {}
    fn private() {}
}
impl Other {
    pub fn not_exported() {}
}
";
        assert_eq!(public_functions(src), vec!["alpha", "beta_2"]);
    }

    #[test]
    fn exemptions_match_by_prefix_or_exactly() {
        let c = cfg();
        assert!(c.exemption_for("c::get_x").is_some());
        assert!(c.exemption_for("c::set_x").is_none());
    }

    #[test]
    fn unmeasured_unexempted_functions_are_flagged() {
        // `coverage_problems` reads real sources; exercise the key logic only.
        let c = cfg();
        let measured = one("c::f#worst", 1, 1);
        let keys: BTreeSet<&str> = measured
            .keys()
            .map(|k| k.split('#').next().unwrap())
            .collect();
        assert!(keys.contains("c::f"));
        assert!(c.exemption_for("c::f").is_none());
    }
}
