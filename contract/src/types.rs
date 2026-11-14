//! What the contract stores and what its functions take and return.

use near_sdk::{near, AccountId, NearToken};

pub type TokenId = String;
pub type OrderId = String;
/// Unix time in milliseconds, as NEP-177 defines its time fields.
pub type TimestampMs = u64;

/// 100% in basis points.
pub const FULL_SHARE: u16 = 10_000;

// ---- thesis token ----

/// Where a thesis's expiry came from.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpirySetBy {
    /// The thesis creator gave the date.
    Creator,
    /// The creator gave none, so ConDex's AI took it from the thesis.
    CondexAi,
    /// The creator gave none and no AI answered, so ConDex applied its default.
    CondexDefault,
}

/// One line of a thesis's revenue split.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitEntry {
    pub account_id: AccountId,
    /// Share of each collected fee, in basis points (10000 = 100%).
    pub basis_points: u16,
}

/// One version of one thesis. Only the fingerprint of its content is on chain.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Thesis {
    /// The thesis creator. The token stays with them.
    pub owner_id: AccountId,
    pub payout_account: AccountId,
    /// Who receives each collected fee. Fixed at minting.
    pub revenue_split: Vec<SplitEntry>,
    /// The usage fee per filled trade, in yoctoNEAR. Fixed at minting.
    pub fee: u128,
    /// SHA-256 of the conditions, the expiry and the approved conversation, as hex.
    pub content_hash: String,
    pub issued_at: TimestampMs,
    pub expires_at: TimestampMs,
    pub expiry_set_by: ExpirySetBy,
    /// How many proofs of trade are recorded on this token.
    pub proof_count: u32,
}

// ---- NEP-171 and NEP-177 views ----

/// A token as `nft_token` returns it.
#[near(serializers = [json])]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

/// NEP-177 token metadata. Times are numbers in Unix milliseconds, as the standard defines them.
#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<TimestampMs>,
    pub expires_at: Option<TimestampMs>,
    pub starts_at: Option<TimestampMs>,
    pub updated_at: Option<TimestampMs>,
    /// The ConDex fields of the token, as a JSON string: see `ThesisExtra`.
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// The ConDex fields of a thesis token, carried in the `extra` field of its metadata.
#[near(serializers = [json])]
pub struct ThesisExtra {
    pub content_hash: String,
    pub fee: NearToken,
    pub payout_account: AccountId,
    pub revenue_split: Vec<SplitEntry>,
    pub expiry_set_by: ExpirySetBy,
    pub proof_count: u32,
    /// Whether the thesis's stated conditions were met, recorded once after its expiry. None until then.
    pub evaluation: Option<Evaluation>,
}

/// What ConDex found when it evaluated a thesis against market data after its expiry. The same eight
/// outcomes as the API (`src/services/evaluation.ts`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The target price was reached before the invalidation price.
    TargetHit,
    /// The invalidation price was reached first.
    Invalidated,
    /// The entry price was never reached, so the thesis was never in play.
    NotTriggered,
    /// Entered, but neither the target nor the invalidation was reached by the deadline.
    TargetMissed,
    /// No target price: at the deadline the price had moved in the thesis's direction.
    InDirection,
    /// No target price: at the deadline it had moved the other way, or not at all.
    AgainstDirection,
    /// The target or invalidation was already passed when the thesis was published, so it is not judged.
    AlreadyReached,
    /// The market data feed had no price for this market.
    NoData,
}

impl Outcome {
    /// Whether the conditions were met, as this outcome says: true, false, or None when it cannot be judged.
    pub fn conditions_met(&self) -> Option<bool> {
        match self {
            Outcome::TargetHit | Outcome::InDirection => Some(true),
            Outcome::Invalidated | Outcome::TargetMissed | Outcome::AgainstDirection => Some(false),
            Outcome::NotTriggered | Outcome::AlreadyReached | Outcome::NoData => None,
        }
    }
}

/// The evaluation of one thesis version, recorded once on its token.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    pub outcome: Outcome,
    pub conditions_met: Option<bool>,
    /// The last price at publishing, and the last price at the deadline. Decimal text.
    pub reference_price: Option<String>,
    pub final_price: Option<String>,
    pub entered_at: Option<TimestampMs>,
    pub target_hit_at: Option<TimestampMs>,
    pub invalidated_at: Option<TimestampMs>,
    /// How many market prices the evaluation used.
    pub prices_used: u32,
    /// The market data feed: "simulated", or "feed:<name>".
    pub source: String,
    /// The token's `expires_at`: prices up to this moment were judged.
    pub deadline: TimestampMs,
    /// When it was recorded, by the block clock. Never before the deadline.
    pub evaluated_at: TimestampMs,
}

/// NEP-177 collection metadata.
#[near(serializers = [json])]
pub struct NFTContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

// ---- balances and reserves ----

/// What the contract holds for one account, in yoctoNEAR.
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Balance {
    /// Free to reserve for a fee or to withdraw: deposits, returned reserves and earned income.
    pub available: u128,
    /// Held for orders that have neither filled nor ended yet.
    pub reserved: u128,
    /// Everything this account was ever credited as income. It only grows.
    pub earned_total: u128,
}

#[near(serializers = [json])]
pub struct BalanceView {
    pub account_id: AccountId,
    /// What the account can withdraw, or reserve for a fee.
    pub available: NearToken,
    pub reserved: NearToken,
    pub earned_total: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReserveStatus {
    Reserved,
    Settled,
    Released,
}

/// The fee held for one order, created by the trader's own approval.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Reserve {
    pub token_id: TokenId,
    pub payer: AccountId,
    pub amount: u128,
    /// Fingerprint of the order the trader approved: see `order_fingerprint`.
    pub order_hash: String,
    /// When the trader approved the order, by the time of the block.
    pub reserved_at: TimestampMs,
    pub status: ReserveStatus,
    pub receipt_id: Option<String>,
    pub finalised_at: Option<TimestampMs>,
}

#[near(serializers = [json])]
pub struct ReserveView {
    pub order_id: OrderId,
    pub token_id: TokenId,
    pub payer: AccountId,
    pub amount: NearToken,
    pub order_hash: String,
    pub reserved_at: TimestampMs,
    pub status: ReserveStatus,
    pub receipt_id: Option<String>,
    pub finalised_at: Option<TimestampMs>,
}

// ---- proof of trade ----

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn as_str(&self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }
}

/// Whether the trader is the thesis creator or someone who borrowed the thesis.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TraderRole {
    Creator,
    Borrower,
}

/// A confirmed fill of the order that opened the trade.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    /// The execution side's own id for the event.
    pub event_id: String,
    pub at: TimestampMs,
    /// Decimal text, in the market's quote currency. Absent when the venue reported none.
    pub price: Option<String>,
    /// Decimal text.
    pub quantity: String,
    /// "simulated", or "venue:<name>" for a live venue.
    pub source: String,
}

/// One closing fill: part or all of the trade was closed at this price.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosingFill {
    pub event_id: String,
    pub at: TimestampMs,
    pub price: String,
    pub quantity: String,
    pub source: String,
}

/// What the reporter sends with `settle_fee`. The contract fills in the rest from its own records.
#[near(serializers = [json])]
pub struct ProofInput {
    /// The order as the trader approved it. It must match the fingerprint stored with the reserve.
    pub market: String,
    pub side: Side,
    pub quantity: String,
    /// The first confirmed fill.
    pub fill: Fill,
}

/// A proof of trade, recorded on its thesis token when the order first fills.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ProofOfTrade {
    pub receipt_id: String,
    pub order_id: OrderId,
    pub token_id: TokenId,
    /// The thesis fingerprint at the time of the trade.
    pub content_hash: String,
    pub trader: AccountId,
    pub role: TraderRole,
    pub market: String,
    pub side: Side,
    pub quantity: String,
    /// When the trader approved the order on this contract.
    pub authorised_at: TimestampMs,
    pub fill: Fill,
    pub fee_paid: NearToken,
    /// Added by `record_close`, oldest first.
    pub closing_fills: Vec<ClosingFill>,
    pub proven_at: TimestampMs,
}

// ---- subscriptions ----

#[near(serializers = [json])]
pub struct SubscriptionView {
    pub account_id: AccountId,
    /// Unix milliseconds. Zero when the account never subscribed.
    pub subscribed_until: TimestampMs,
    pub active: bool,
    /// The current terms: what one period costs and how long it lasts, in milliseconds.
    pub price: NearToken,
    pub period: u64,
}
