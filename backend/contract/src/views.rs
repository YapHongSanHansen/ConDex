//! Read functions. Anyone can call them, and they cost nothing.

use near_sdk::{near, AccountId};

use crate::types::{BalanceView, OrderId, ProofOfTrade, ReserveView, TokenId};
use crate::{Contract, ContractExt};

const DEFAULT_PROOFS_PER_PAGE: u32 = 50;
const MAX_PROOFS_PER_PAGE: u32 = 100;

#[near]
impl Contract {
    /// What the contract holds for an account: available (free to withdraw or to reserve for a fee),
    /// reserved, and everything it ever earned.
    pub fn balance_of(&self, account_id: AccountId) -> BalanceView {
        self.balance_view(account_id)
    }

    /// The fee reserve of an order, with the order fingerprint the trader approved and its status.
    /// Nothing when the order has no reserve.
    pub fn get_reserve(&self, order_id: OrderId) -> Option<ReserveView> {
        self.reserve_view(&order_id)
    }

    /// The proofs of trade recorded on a token, each with its closing fills, in the order they were proven.
    /// `from_index` starts at 0. `limit` defaults to 50 and is at most 100.
    pub fn get_proofs(
        &self,
        token_id: TokenId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<ProofOfTrade> {
        let count = match self.theses.get(&token_id) {
            Some(thesis) => thesis.proof_count,
            None => return Vec::new(),
        };
        let from = from_index.unwrap_or(0);
        let limit = limit
            .unwrap_or(DEFAULT_PROOFS_PER_PAGE)
            .min(MAX_PROOFS_PER_PAGE);
        (from..count)
            .take(limit as usize)
            .filter_map(|index| self.proof_index.get(&(token_id.clone(), index)))
            .filter_map(|order_id| self.proofs.get(order_id).cloned())
            .collect()
    }
}
