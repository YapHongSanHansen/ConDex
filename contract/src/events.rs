//! Event logs (NEP-297), so explorers and indexers can follow what the contract did.

use near_sdk::{near, AccountId, NearToken};

use crate::types::{OrderId, TimestampMs, TokenId};

/// The NEP-171 event wallets and explorers look for when a token is minted.
#[near(event_json(standard = "nep171"))]
pub enum Nep171Event {
    #[event_version("1.0.0")]
    NftMint(Vec<NftMintLog>),
}

#[near(serializers = [json])]
pub struct NftMintLog {
    pub owner_id: AccountId,
    pub token_ids: Vec<TokenId>,
}

/// ConDex's own events.
#[near(event_json(standard = "condex"))]
pub enum CondexEvent {
    #[event_version("1.0.0")]
    Deposit {
        account_id: AccountId,
        amount: NearToken,
    },

    #[event_version("1.0.0")]
    Withdraw {
        account_id: AccountId,
        amount: NearToken,
    },

    /// The transfer failed, so the amount is back on the account's balance.
    #[event_version("1.0.0")]
    WithdrawFailed {
        account_id: AccountId,
        amount: NearToken,
    },

    #[event_version("1.0.0")]
    FeeReserved {
        order_id: OrderId,
        token_id: TokenId,
        payer: AccountId,
        amount: NearToken,
        order_hash: String,
    },

    #[event_version("1.0.0")]
    FeeSettled {
        order_id: OrderId,
        token_id: TokenId,
        receipt_id: String,
        payer: AccountId,
        amount: NearToken,
    },

    #[event_version("1.0.0")]
    FeeReleased {
        order_id: OrderId,
        token_id: TokenId,
        payer: AccountId,
        amount: NearToken,
    },

    #[event_version("1.0.0")]
    TradeClosed {
        order_id: OrderId,
        token_id: TokenId,
        event_id: String,
        quantity: String,
        price: String,
    },

    #[event_version("1.0.0")]
    Subscribed {
        account_id: AccountId,
        paid: NearToken,
        subscribed_until: TimestampMs,
    },

    #[event_version("1.0.0")]
    SubscriptionTermsSet { price: NearToken, period: u64 },
}
