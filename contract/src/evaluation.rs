//! The evaluation of a thesis: whether its stated conditions were met, recorded once on its token after
//! the expiry. Step 5 of the flow; the README's "the NFT records the thesis and its verified results".
//!
//! Evaluations are kept under their own storage prefix instead of a field of `Contract`, so adding them did
//! not change the stored contract state: the upgrade is a plain redeploy, with no migration.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require};

use crate::events::CondexEvent;
use crate::types::{Evaluation, Outcome, TimestampMs, TokenId};
use crate::{assert_positive_decimal, Contract, ContractExt, StorageKey};

fn evaluations() -> LookupMap<TokenId, Evaluation> {
    LookupMap::new(StorageKey::Evaluations)
}

/// The evaluation recorded on a token, if any.
pub(crate) fn evaluation_of(token_id: &TokenId) -> Option<Evaluation> {
    evaluations().get(token_id).cloned()
}

/// A market data source: "simulated", or "feed:<name>" for a live feed.
fn assert_market_source(value: &str) {
    let ok = value == "simulated"
        || value.strip_prefix("feed:").is_some_and(|name| {
            !name.is_empty()
                && name.len() <= 48
                && name.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
                })
        });
    require!(ok, "source must be \"simulated\" or \"feed:<name>\"");
}

#[near]
impl Contract {
    /// Records the evaluation of `token_id`. Only the reporter can call it, and only once the token has
    /// expired by the block clock, so an evaluation can never be recorded before its deadline.
    ///
    /// `conditions_met` must agree with `outcome` (true for target_hit and in_direction, false for
    /// invalidated, target_missed and against_direction, null otherwise). Times are Unix milliseconds.
    ///
    /// Returns true when it was recorded, and false when the token already has an evaluation, in which case
    /// nothing changes: an evaluation is never replaced.
    #[allow(clippy::too_many_arguments)]
    pub fn record_evaluation(
        &mut self,
        token_id: TokenId,
        outcome: Outcome,
        conditions_met: Option<bool>,
        reference_price: Option<String>,
        final_price: Option<String>,
        entered_at: Option<TimestampMs>,
        target_hit_at: Option<TimestampMs>,
        invalidated_at: Option<TimestampMs>,
        prices_used: u32,
        source: String,
    ) -> bool {
        self.assert_reporter();
        let deadline = match self.theses.get(&token_id) {
            Some(thesis) => thesis.expires_at,
            None => env::panic_str(&format!("Token {token_id} does not exist")),
        };
        let now = env::block_timestamp_ms();
        require!(
            now >= deadline,
            format!("Thesis {token_id} has not expired yet, so it cannot be evaluated before its deadline")
        );
        let mut stored = evaluations();
        if stored.contains_key(&token_id) {
            return false;
        }

        require!(
            conditions_met == outcome.conditions_met(),
            "conditions_met does not agree with the outcome"
        );
        for (price, field) in [(&reference_price, "reference_price"), (&final_price, "final_price")] {
            if let Some(price) = price {
                assert_positive_decimal(price, field);
            }
        }
        for (at, field) in [(entered_at, "entered_at"), (target_hit_at, "target_hit_at"), (invalidated_at, "invalidated_at")] {
            if let Some(at) = at {
                require!(at <= deadline, format!("{field} is after the deadline"));
            }
        }
        assert_market_source(&source);

        stored.insert(
            token_id.clone(),
            Evaluation {
                outcome,
                conditions_met,
                reference_price,
                final_price,
                entered_at,
                target_hit_at,
                invalidated_at,
                prices_used,
                source,
                deadline,
                evaluated_at: now,
            },
        );
        stored.flush();

        CondexEvent::ThesisEvaluated { token_id, outcome, conditions_met }.emit();
        true
    }

    /// The evaluation recorded on `token_id`, or null when there is none yet.
    pub fn get_evaluation(&self, token_id: TokenId) -> Option<Evaluation> {
        evaluation_of(&token_id)
    }
}
