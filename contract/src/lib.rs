//! ConDex on NEAR: one contract for thesis NFTs, fee escrow, proofs of trade and subscriptions.
//!
//! The plan this follows is in `docs/near-contract.md`. Each feature has its own file:
//!
//! - `nft.rs`: mint a thesis token and read it (NEP-171, NEP-177). Transfers always fail.
//! - `escrow.rs`: deposit, withdraw, the trader's approval of an order and its fee, settle, release.
//! - `close.rs`: record a closing fill on a proof of trade.
//! - `subscription.rs`: subscribe, set the terms, read a subscription.
//! - `views.rs`: read balances, reserves and proofs of trade.
//!
//! Amounts are in yoctoNEAR. Times are Unix milliseconds.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

mod close;
mod escrow;
mod events;
mod nft;
mod subscription;
mod types;
mod views;

#[cfg(test)]
mod tests;

pub use events::*;
pub use types::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Theses,
    Balances,
    Reserves,
    Proofs,
    ProofIndex,
    Subscriptions,
    CloseEvents,
}

#[near(
    contract_state,
    contract_metadata(
        standard(standard = "nep171", version = "1.0.0"),
        standard(standard = "nep177", version = "2.0.0"),
        standard(standard = "nep297", version = "1.0.0"),
    )
)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Sets the subscription terms and receives subscription income.
    owner_id: AccountId,
    /// The ConDex account that publishes: it may mint thesis tokens and nothing else.
    operator_id: AccountId,
    /// The ConDex account that reports execution: it may settle, release and record a close.
    reporter_id: AccountId,

    subscription_price: u128,
    /// Length of one subscription period, in milliseconds.
    subscription_period: u64,

    theses: LookupMap<TokenId, Thesis>,
    balances: LookupMap<AccountId, Balance>,
    /// The fee reserve of each order.
    reserves: LookupMap<OrderId, Reserve>,
    /// The proof of trade of each order that filled.
    proofs: LookupMap<OrderId, ProofOfTrade>,
    /// The orders with a proof on each token, in the order they were proven.
    proof_index: LookupMap<(TokenId, u32), OrderId>,
    /// Until when each account is subscribed.
    subscriptions: LookupMap<AccountId, TimestampMs>,
    /// Which order each recorded close event belongs to, so a repeat changes nothing.
    close_events: LookupMap<String, OrderId>,
}

#[near]
impl Contract {
    /// Sets up the contract. Runs once, at deployment.
    ///
    /// `subscription_period` is the length of one subscription period in milliseconds.
    #[init]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        reporter_id: AccountId,
        subscription_price: NearToken,
        subscription_period: u64,
    ) -> Self {
        require!(
            operator_id != reporter_id,
            "The operator and the reporter must be separate accounts"
        );
        require!(
            subscription_period > 0,
            "subscription_period must be greater than zero"
        );
        Self {
            owner_id,
            operator_id,
            reporter_id,
            subscription_price: subscription_price.as_yoctonear(),
            subscription_period,
            theses: LookupMap::new(StorageKey::Theses),
            balances: LookupMap::new(StorageKey::Balances),
            reserves: LookupMap::new(StorageKey::Reserves),
            proofs: LookupMap::new(StorageKey::Proofs),
            proof_index: LookupMap::new(StorageKey::ProofIndex),
            subscriptions: LookupMap::new(StorageKey::Subscriptions),
            close_events: LookupMap::new(StorageKey::CloseEvents),
        }
    }
}

// ---- shared helpers ----

impl Contract {
    pub(crate) fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can do this"
        );
    }

    pub(crate) fn assert_operator(&self) {
        require!(
            env::predecessor_account_id() == self.operator_id,
            "Only the operator can do this"
        );
    }

    pub(crate) fn assert_reporter(&self) {
        require!(
            env::predecessor_account_id() == self.reporter_id,
            "Only the reporter can do this"
        );
    }

    /// The balance of an account. An account the contract has never seen holds nothing.
    pub(crate) fn balance(&self, account_id: &AccountId) -> Balance {
        self.balances.get(account_id).cloned().unwrap_or_default()
    }

    /// Adds income to an account: it becomes available to withdraw and counts in the total earned.
    pub(crate) fn credit_income(&mut self, account_id: &AccountId, amount: u128) {
        let mut balance = self.balance(account_id);
        balance.available += amount;
        balance.earned_total += amount;
        self.balances.insert(account_id.clone(), balance);
    }

    pub(crate) fn balance_view(&self, account_id: AccountId) -> BalanceView {
        let balance = self.balance(&account_id);
        BalanceView {
            account_id,
            available: NearToken::from_yoctonear(balance.available),
            reserved: NearToken::from_yoctonear(balance.reserved),
            earned_total: NearToken::from_yoctonear(balance.earned_total),
        }
    }
}

/// Fingerprint of an order as the trader approved it: SHA-256, as hex, of
/// `condex-order-v1|<order_id>|<token_id>|<market>|<buy or sell>|<quantity>`.
///
/// The trader sends it with `reserve_fee`. At settlement the contract rebuilds it from the order in the
/// proof, so the order cannot be changed after the approval.
pub fn order_fingerprint(
    order_id: &str,
    token_id: &str,
    market: &str,
    side: Side,
    quantity: &str,
) -> String {
    let text = format!(
        "condex-order-v1|{order_id}|{token_id}|{market}|{}|{quantity}",
        side.as_str()
    );
    to_hex(&env::sha256_array(text.as_bytes()))
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

// ---- input checks ----
// None of these may contain "|", which separates the parts of an order fingerprint.

/// An id as ConDex issues them: letters, digits, "_", "-" and ".", at most 128 characters.
pub(crate) fn assert_id(value: &str, field: &str) {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    require!(
        ok,
        format!("{field} must be 1 to 128 letters, digits, '_', '-' or '.'")
    );
}

/// A SHA-256 as 64 lowercase hex characters.
pub(crate) fn assert_hash(value: &str, field: &str) {
    let ok = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    require!(
        ok,
        format!("{field} must be a SHA-256 as 64 lowercase hex characters")
    );
}

/// A market name such as "ETH-USD".
pub(crate) fn assert_market(value: &str) {
    let ok = !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|b| {
            b.is_ascii_uppercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.' | b'/')
        });
    require!(
        ok,
        "market must be 1 to 32 upper-case letters, digits, '-', '_', '.' or '/'"
    );
}

/// A positive decimal such as "1.5", with at most 18 decimal places, as the ConDex API writes them.
pub(crate) fn assert_positive_decimal(value: &str, field: &str) {
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (value, None),
    };
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    let well_formed =
        digits(whole) && whole.len() <= 30 && fraction.is_none_or(|f| digits(f) && f.len() <= 18);
    require!(
        well_formed,
        format!("{field} must be a decimal like \"1.5\"")
    );
    let positive = value.bytes().any(|b| (b'1'..=b'9').contains(&b));
    require!(positive, format!("{field} must be greater than zero"));
}

/// Where the evidence came from: "simulated", or "venue:<name>" for a live venue.
pub(crate) fn assert_source(value: &str) {
    let ok = value == "simulated"
        || value.strip_prefix("venue:").is_some_and(|name| {
            !name.is_empty()
                && name.len() <= 48
                && name.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
                })
        });
    require!(ok, "source must be \"simulated\" or \"venue:<name>\"");
}
