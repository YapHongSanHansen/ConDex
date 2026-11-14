//! Subscriptions: the contract records until when an account is subscribed. The ConDex API reads it
//! before serving the complete thesis or the limited preview.

use near_sdk::{env, near, require, AccountId, NearToken};

use crate::events::CondexEvent;
use crate::types::SubscriptionView;
use crate::{Contract, ContractExt};

#[near]
impl Contract {
    /// Buys one subscription period for the caller. Attach exactly the subscription price.
    ///
    /// The period counts from now, or from the end of the current subscription when that is later.
    /// The payment is credited to the owner's balance.
    #[payable]
    pub fn subscribe(&mut self) -> SubscriptionView {
        let account_id = env::predecessor_account_id();
        let paid = env::attached_deposit();
        require!(
            paid.as_yoctonear() == self.subscription_price,
            format!(
                "One subscription period costs exactly {} yoctoNEAR",
                self.subscription_price
            )
        );

        let now = env::block_timestamp_ms();
        let current_end = self.subscriptions.get(&account_id).copied().unwrap_or(0);
        let subscribed_until = current_end.max(now) + self.subscription_period;
        self.subscriptions
            .insert(account_id.clone(), subscribed_until);

        let owner_id = self.owner_id.clone();
        self.credit_income(&owner_id, paid.as_yoctonear());

        CondexEvent::Subscribed {
            account_id: account_id.clone(),
            paid,
            subscribed_until,
        }
        .emit();
        self.subscription_of(account_id)
    }

    /// Sets what one period costs and how long it lasts, in milliseconds. Only the owner can.
    /// Subscriptions already bought keep their end date.
    pub fn set_subscription_terms(&mut self, price: NearToken, period: u64) {
        self.assert_owner();
        require!(period > 0, "period must be greater than zero");
        self.subscription_price = price.as_yoctonear();
        self.subscription_period = period;
        CondexEvent::SubscriptionTermsSet { price, period }.emit();
    }

    /// Until when an account is subscribed, and the current terms.
    pub fn subscription_of(&self, account_id: AccountId) -> SubscriptionView {
        let subscribed_until = self.subscriptions.get(&account_id).copied().unwrap_or(0);
        SubscriptionView {
            account_id,
            subscribed_until,
            active: subscribed_until > env::block_timestamp_ms(),
            price: NearToken::from_yoctonear(self.subscription_price),
            period: self.subscription_period,
        }
    }
}
