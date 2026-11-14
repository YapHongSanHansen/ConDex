//! Closing a trade: each closing fill is added to the trade's proof.

use near_sdk::{env, near, require};

use crate::events::CondexEvent;
use crate::types::{ClosingFill, OrderId, TimestampMs};
use crate::{assert_id, assert_positive_decimal, assert_source, Contract, ContractExt};

/// A proof of trade is stored whole, so its list of closing fills has to stay small.
const MAX_CLOSING_FILLS: usize = 100;

#[near]
impl Contract {
    /// Adds one closing fill to the proof of trade of `order_id`. Only the reporter can call it.
    ///
    /// A trade closed in parts takes one call per closing fill. A close pays nothing and charges nothing,
    /// and it works after the thesis has expired. `closed_at` is Unix milliseconds.
    ///
    /// Returns true when the fill was recorded, and false when this `event_id` was recorded for this
    /// order already, in which case nothing changes.
    pub fn record_close(
        &mut self,
        order_id: OrderId,
        event_id: String,
        quantity: String,
        price: String,
        closed_at: TimestampMs,
        source: String,
    ) -> bool {
        self.assert_reporter();
        assert_id(&event_id, "event_id");

        let mut proof = match self.proofs.get(&order_id) {
            Some(proof) => proof.clone(),
            None => env::panic_str(&format!(
                "Order {order_id} has no proof of trade, so there is no trade to close"
            )),
        };
        if let Some(recorded_for) = self.close_events.get(&event_id) {
            require!(
                *recorded_for == order_id,
                format!("Event {event_id} was already used for another order")
            );
            return false;
        }

        assert_positive_decimal(&quantity, "quantity");
        assert_positive_decimal(&price, "price");
        assert_source(&source);
        require!(
            proof.closing_fills.len() < MAX_CLOSING_FILLS,
            format!("A trade can have at most {MAX_CLOSING_FILLS} closing fills")
        );

        proof.closing_fills.push(ClosingFill {
            event_id: event_id.clone(),
            at: closed_at,
            price: price.clone(),
            quantity: quantity.clone(),
            source,
        });
        let token_id = proof.token_id.clone();
        self.proofs.insert(order_id.clone(), proof);
        self.close_events.insert(event_id.clone(), order_id.clone());

        CondexEvent::TradeClosed {
            order_id,
            token_id,
            event_id,
            quantity,
            price,
        }
        .emit();
        true
    }
}
