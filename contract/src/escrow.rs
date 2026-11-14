//! Fee escrow: the trader's deposit, their approval of an order and its fee, and what happens to the fee.

use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

use crate::events::CondexEvent;
use crate::types::{
    BalanceView, OrderId, ProofInput, ProofOfTrade, Reserve, ReserveStatus, ReserveView, TokenId,
    TraderRole, FULL_SHARE,
};
use crate::{
    assert_hash, assert_id, assert_market, assert_positive_decimal, assert_source,
    order_fingerprint, Contract, ContractExt,
};

const GAS_FOR_ON_WITHDRAW: Gas = Gas::from_tgas(10);

#[near]
impl Contract {
    /// Adds the attached NEAR to the caller's available balance, to cover future fees.
    #[payable]
    pub fn deposit(&mut self) -> BalanceView {
        let account_id = env::predecessor_account_id();
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "Attach the NEAR you want to deposit");

        let mut balance = self.balance(&account_id);
        balance.available += amount.as_yoctonear();
        self.balances.insert(account_id.clone(), balance);

        CondexEvent::Deposit {
            account_id: account_id.clone(),
            amount,
        }
        .emit();
        self.balance_view(account_id)
    }

    /// Sends the caller part of their available balance: unused deposit, earned fees or subscription income.
    ///
    /// The amount leaves the balance at once. If the transfer then fails, `on_withdraw` puts it back.
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        let account_id = env::predecessor_account_id();
        require!(!amount.is_zero(), "amount must be greater than zero");

        let mut balance = self.balance(&account_id);
        require!(
            balance.available >= amount.as_yoctonear(),
            format!(
                "Only {} yoctoNEAR is available to withdraw",
                balance.available
            )
        );
        balance.available -= amount.as_yoctonear();
        self.balances.insert(account_id.clone(), balance);

        Promise::new(account_id.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_WITHDRAW)
                .on_withdraw(account_id, amount),
        )
    }

    /// Runs after the transfer of a withdrawal. Only the contract itself can call it.
    /// Returns whether the NEAR arrived; if it did not, the amount is back on the account's balance.
    #[private]
    pub fn on_withdraw(
        &mut self,
        account_id: AccountId,
        amount: NearToken,
        #[callback_result] transfer: Result<(), PromiseError>,
    ) -> bool {
        if transfer.is_ok() {
            CondexEvent::Withdraw { account_id, amount }.emit();
            return true;
        }
        let mut balance = self.balance(&account_id);
        balance.available += amount.as_yoctonear();
        self.balances.insert(account_id.clone(), balance);
        CondexEvent::WithdrawFailed { account_id, amount }.emit();
        false
    }

    /// The trader's one approval of a trade and its fee. The caller is the payer: nobody else, ConDex
    /// included, can reserve a trader's funds.
    ///
    /// Moves `fee` from the caller's available balance into a reserve for `order_id`, linked to one
    /// thesis version. `fee` is the amount the trader was shown and must equal the fee on the token.
    /// `order_hash` is the fingerprint of the order's market, side and quantity (`order_fingerprint`);
    /// the proof recorded at settlement has to match it.
    ///
    /// Refused when the thesis has expired, the fee differs, the balance is too small, or the order
    /// already has a reserve. Takes no attached NEAR, so a key limited to this function can call it.
    pub fn reserve_fee(
        &mut self,
        order_id: OrderId,
        token_id: TokenId,
        fee: NearToken,
        order_hash: String,
    ) -> ReserveView {
        let payer = env::predecessor_account_id();
        assert_id(&order_id, "order_id");
        assert_hash(&order_hash, "order_hash");

        let (thesis_fee, expires_at) = match self.theses.get(&token_id) {
            Some(thesis) => (thesis.fee, thesis.expires_at),
            None => env::panic_str(&format!("Token {token_id} does not exist")),
        };
        let now = env::block_timestamp_ms();
        require!(
            now < expires_at,
            format!("Thesis {token_id} has expired, so no new trade can be linked to it")
        );
        require!(
            fee.as_yoctonear() == thesis_fee,
            format!(
                "The fee of thesis {token_id} is {thesis_fee} yoctoNEAR, not {}",
                fee.as_yoctonear()
            )
        );
        require!(
            !self.reserves.contains_key(&order_id),
            format!("Order {order_id} already has a reserve")
        );

        let mut balance = self.balance(&payer);
        require!(
            balance.available >= thesis_fee,
            format!(
                "The fee needs {thesis_fee} yoctoNEAR but only {} is available. Deposit first",
                balance.available
            )
        );
        balance.available -= thesis_fee;
        balance.reserved += thesis_fee;
        self.balances.insert(payer.clone(), balance);

        self.reserves.insert(
            order_id.clone(),
            Reserve {
                token_id: token_id.clone(),
                payer: payer.clone(),
                amount: thesis_fee,
                order_hash: order_hash.clone(),
                reserved_at: now,
                status: ReserveStatus::Reserved,
                receipt_id: None,
                finalised_at: None,
            },
        );
        CondexEvent::FeeReserved {
            order_id: order_id.clone(),
            token_id,
            payer,
            amount: fee,
            order_hash,
        }
        .emit();
        self.reserve_view(&order_id)
            .unwrap_or_else(|| env::panic_str("The reserve was not stored"))
    }

    /// The order's first confirmed fill. Only the reporter can call it.
    ///
    /// Credits the reserved fee to the thesis's revenue split and records the proof of trade on the token.
    /// The order in `proof` must be the one the trader approved. It works after the thesis has expired:
    /// what counts is that the order was approved in time.
    ///
    /// Returns true when this call settled the fee, and false when it was settled already, in which case
    /// nothing changes.
    pub fn settle_fee(&mut self, order_id: OrderId, receipt_id: String, proof: ProofInput) -> bool {
        self.assert_reporter();
        let mut reserve = self.reserve_or_panic(&order_id);
        match reserve.status {
            ReserveStatus::Settled => return false,
            ReserveStatus::Released => env::panic_str(&format!(
                "The reserve of order {order_id} was already released"
            )),
            ReserveStatus::Reserved => {}
        }

        assert_id(&receipt_id, "receipt_id");
        assert_market(&proof.market);
        assert_positive_decimal(&proof.quantity, "proof.quantity");
        assert_id(&proof.fill.event_id, "proof.fill.event_id");
        assert_positive_decimal(&proof.fill.quantity, "proof.fill.quantity");
        if let Some(price) = &proof.fill.price {
            assert_positive_decimal(price, "proof.fill.price");
        }
        assert_source(&proof.fill.source);
        require!(
            order_fingerprint(
                &order_id,
                &reserve.token_id,
                &proof.market,
                proof.side,
                &proof.quantity
            ) == reserve.order_hash,
            "The order in this proof is not the one the trader approved"
        );

        let mut thesis = match self.theses.get(&reserve.token_id) {
            Some(thesis) => thesis.clone(),
            None => env::panic_str(&format!("Token {} does not exist", reserve.token_id)),
        };

        // The fee leaves the trader's reserve and is credited by the split. Rounding goes to the first entry.
        let mut payer_balance = self.balance(&reserve.payer);
        payer_balance.reserved -= reserve.amount;
        self.balances.insert(reserve.payer.clone(), payer_balance);
        let mut left = reserve.amount;
        for entry in thesis.revenue_split.iter().skip(1) {
            let share = reserve.amount * u128::from(entry.basis_points) / u128::from(FULL_SHARE);
            self.credit_income(&entry.account_id, share);
            left -= share;
        }
        if let Some(first) = thesis.revenue_split.first() {
            self.credit_income(&first.account_id, left);
        }

        let now = env::block_timestamp_ms();
        self.proofs.insert(
            order_id.clone(),
            ProofOfTrade {
                receipt_id: receipt_id.clone(),
                order_id: order_id.clone(),
                token_id: reserve.token_id.clone(),
                content_hash: thesis.content_hash.clone(),
                trader: reserve.payer.clone(),
                role: if reserve.payer == thesis.owner_id {
                    TraderRole::Creator
                } else {
                    TraderRole::Borrower
                },
                market: proof.market,
                side: proof.side,
                quantity: proof.quantity,
                authorised_at: reserve.reserved_at,
                fill: proof.fill,
                fee_paid: NearToken::from_yoctonear(reserve.amount),
                closing_fills: Vec::new(),
                proven_at: now,
            },
        );
        self.proof_index.insert(
            (reserve.token_id.clone(), thesis.proof_count),
            order_id.clone(),
        );
        thesis.proof_count += 1;
        self.theses.insert(reserve.token_id.clone(), thesis);

        reserve.status = ReserveStatus::Settled;
        reserve.receipt_id = Some(receipt_id.clone());
        reserve.finalised_at = Some(now);
        self.reserves.insert(order_id.clone(), reserve.clone());

        CondexEvent::FeeSettled {
            order_id,
            token_id: reserve.token_id,
            receipt_id,
            payer: reserve.payer,
            amount: NearToken::from_yoctonear(reserve.amount),
        }
        .emit();
        true
    }

    /// The order ended with no fills. Only the reporter can call it.
    ///
    /// Returns the reserve to the trader's available balance. Returns true when this call released it,
    /// and false when it was released already, in which case nothing changes.
    pub fn release_fee(&mut self, order_id: OrderId) -> bool {
        self.assert_reporter();
        let mut reserve = self.reserve_or_panic(&order_id);
        match reserve.status {
            ReserveStatus::Released => return false,
            ReserveStatus::Settled => env::panic_str(&format!(
                "The reserve of order {order_id} was already settled"
            )),
            ReserveStatus::Reserved => {}
        }

        let mut balance = self.balance(&reserve.payer);
        balance.reserved -= reserve.amount;
        balance.available += reserve.amount;
        self.balances.insert(reserve.payer.clone(), balance);

        reserve.status = ReserveStatus::Released;
        reserve.finalised_at = Some(env::block_timestamp_ms());
        self.reserves.insert(order_id.clone(), reserve.clone());

        CondexEvent::FeeReleased {
            order_id,
            token_id: reserve.token_id,
            payer: reserve.payer,
            amount: NearToken::from_yoctonear(reserve.amount),
        }
        .emit();
        true
    }
}

impl Contract {
    fn reserve_or_panic(&self, order_id: &OrderId) -> Reserve {
        match self.reserves.get(order_id) {
            Some(reserve) => reserve.clone(),
            None => env::panic_str(&format!("Order {order_id} has no fee reserve")),
        }
    }

    pub(crate) fn reserve_view(&self, order_id: &OrderId) -> Option<ReserveView> {
        let reserve = self.reserves.get(order_id)?;
        Some(ReserveView {
            order_id: order_id.clone(),
            token_id: reserve.token_id.clone(),
            payer: reserve.payer.clone(),
            amount: NearToken::from_yoctonear(reserve.amount),
            order_hash: reserve.order_hash.clone(),
            reserved_at: reserve.reserved_at,
            status: reserve.status,
            receipt_id: reserve.receipt_id.clone(),
            finalised_at: reserve.finalised_at,
        })
    }
}
