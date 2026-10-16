// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, Symbol, Vec};

/// Bridge configuration settings.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeConfig {
    /// Admin address with control over bridge settings.
    pub admin: Address,

    /// Minimum amount that can be locked.
    pub min_lock_amount: i128,

    /// Maximum amount that can be locked.
    pub max_lock_amount: i128,

    /// List of supported destination chains.
    pub supported_chains: Vec<Symbol>,

    /// Whether bridge operations are currently paused.
    pub paused: bool,
}

/// Bridge operation state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeOperation {
    /// Unique operation identifier.
    pub operation_id: Symbol,

    /// Address initiating the operation.
    pub from: Address,

    /// Recipient address on the target chain.
    pub to: Address,

    /// Amount being transferred.
    pub amount: i128,

    /// Source chain identifier.
    pub source_chain: Symbol,

    /// Destination chain identifier.
    pub destination_chain: Symbol,

    /// Current operation status.
    pub status: Symbol,

    /// Operation timestamp.
    pub timestamp: u64,
}

/// Bridge state information.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeState {
    /// Current bridge configuration.
    pub config: BridgeConfig,

    /// Total amount locked across all operations.
    pub total_locked: i128,

    /// Total amount minted across all operations.
    pub total_minted: i128,

    /// Total amount burned across all operations.
    pub total_burned: i128,
}

/// One source chain's rolling daily mint-volume window (issue #858).
/// `window_start` is a ledger timestamp (seconds); the window rolls over —
/// resetting `volume` to 0 — the next time a mint is checked after
/// `window_start + DAILY_CAP_WINDOW_SECONDS` has elapsed, rather than on a
/// fixed wall-clock boundary.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ChainVolumeWindow {
    pub window_start: u64,
    pub volume: i128,
}

/// A proposed daily-cap increase awaiting its timelock (issue #858).
/// `execute_after` is a ledger sequence number, mirroring the
/// propose/execute timelock pattern used elsewhere in this workspace (e.g.
/// escrow's `PendingPenaltyProposal`). Only raising an existing cap is
/// timelocked — see `StellarBridgeAdapter::set_daily_cap`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingCapIncrease {
    pub new_cap: i128,
    pub execute_after: u32,
}

/// Asset information for cross-chain transfers.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AssetInfo {
    /// Asset identifier (e.g., token address or symbol).
    pub asset_id: Symbol,

    /// Asset name.
    pub name: Symbol,

    /// Asset symbol.
    pub symbol: Symbol,

    /// Number of decimals.
    pub decimals: u32,

    /// Whether the asset is native to the chain.
    pub is_native: bool,
}
