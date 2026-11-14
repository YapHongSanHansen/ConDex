//! Unit tests. They run the contract's functions against the SDK's mocked blockchain.
//!
//! Alice is the thesis creator and Bob is the trader. Her thesis costs 0.1 NEAR per filled trade and
//! expires at `EXPIRY`.

use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{serde_json, testing_env, AccountId, NearToken, PromiseError};

use crate::*;

const HOUR: u64 = 3_600_000;
const T0: u64 = 1_800_000_000_000;
const EXPIRY: u64 = T0 + 24 * HOUR;
const FEE: NearToken = NearToken::from_millinear(100);
const PRICE: NearToken = NearToken::from_near(2);
const PERIOD: u64 = 30 * 24 * HOUR;
const NOTHING: NearToken = NearToken::from_yoctonear(0);

const TOKEN: &str = "ins_abc-v1";
const ORDER: &str = "ord_1";
const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}
fn owner() -> AccountId {
    account("condex.testnet")
}
fn operator() -> AccountId {
    account("operator.condex.testnet")
}
fn reporter() -> AccountId {
    account("reporter.condex.testnet")
}
fn alice() -> AccountId {
    account("alice.testnet")
}
fn bob() -> AccountId {
    account("bob.testnet")
}
fn contract_account() -> AccountId {
    account("contract.condex.testnet")
}

/// What follows runs as `caller`, at `now` (Unix milliseconds), with `attached` NEAR.
fn call_as(caller: &AccountId, now: u64, attached: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_account())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller.clone())
        .block_timestamp(now * 1_000_000)
        .attached_deposit(attached)
        .build());
}

fn new_contract() -> Contract {
    call_as(&owner(), T0, NOTHING);
    Contract::new(owner(), operator(), reporter(), PRICE, PERIOD)
}

fn mint(contract: &mut Contract, token_id: &str) {
    call_as(&operator(), T0, NOTHING);
    contract.mint_thesis(
        token_id.to_string(),
        alice(),
        alice(),
        FEE,
        HASH.to_string(),
        T0,
        EXPIRY,
        ExpirySetBy::Creator,
        None,
    );
}

/// A contract with Alice's thesis minted and 1 NEAR deposited by Bob.
fn with_thesis_and_deposit() -> Contract {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    call_as(&bob(), T0, NearToken::from_near(1));
    contract.deposit();
    contract
}

/// The fingerprint of Bob's usual order: sell 2 ETH-USD.
fn order_hash(order_id: &str) -> String {
    order_fingerprint(order_id, TOKEN, "ETH-USD", Side::Sell, "2")
}

fn reserve(contract: &mut Contract, order_id: &str, now: u64) -> ReserveView {
    call_as(&bob(), now, NOTHING);
    contract.reserve_fee(
        order_id.to_string(),
        TOKEN.to_string(),
        FEE,
        order_hash(order_id),
    )
}

fn proof(quantity: &str) -> ProofInput {
    ProofInput {
        market: "ETH-USD".to_string(),
        side: Side::Sell,
        quantity: quantity.to_string(),
        fill: Fill {
            event_id: "evt_fill_1".to_string(),
            at: T0 + HOUR,
            price: Some("3500".to_string()),
            quantity: "1".to_string(),
            source: "simulated".to_string(),
        },
    }
}

fn settle(contract: &mut Contract, order_id: &str, now: u64) -> bool {
    call_as(&reporter(), now, NOTHING);
    contract.settle_fee(order_id.to_string(), format!("rcpt_{order_id}"), proof("2"))
}

fn close(
    contract: &mut Contract,
    order_id: &str,
    event_id: &str,
    quantity: &str,
    price: &str,
) -> bool {
    call_as(&reporter(), EXPIRY + HOUR, NOTHING);
    contract.record_close(
        order_id.to_string(),
        event_id.to_string(),
        quantity.to_string(),
        price.to_string(),
        EXPIRY + HOUR,
        "simulated".to_string(),
    )
}

fn available(contract: &Contract, account_id: AccountId) -> NearToken {
    contract.balance_of(account_id).available
}

// ---- setup ----

#[test]
#[should_panic(expected = "The operator and the reporter must be separate accounts")]
fn the_operator_and_the_reporter_must_differ() {
    call_as(&owner(), T0, NOTHING);
    Contract::new(owner(), operator(), operator(), PRICE, PERIOD);
}

// ---- thesis NFT ----

#[test]
fn the_operator_mints_a_thesis_and_anyone_can_read_it() {
    let mut contract = new_contract();
    call_as(&operator(), T0, NOTHING);
    contract.mint_thesis(
        TOKEN.to_string(),
        alice(),
        account("alice-payout.testnet"),
        FEE,
        HASH.to_string(),
        T0,
        EXPIRY,
        ExpirySetBy::CondexAi,
        None,
    );
    assert_eq!(
        get_logs(),
        vec![
            r#"EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"nft_mint","data":[{"owner_id":"alice.testnet","token_ids":["ins_abc-v1"]}]}"#
        ]
    );

    let token = contract
        .nft_token(TOKEN.to_string())
        .expect("the token exists");
    assert_eq!(token.token_id, TOKEN);
    assert_eq!(token.owner_id, alice());
    assert_eq!(token.metadata.issued_at, Some(T0));
    assert_eq!(token.metadata.expires_at, Some(EXPIRY));

    let extra: serde_json::Value =
        serde_json::from_str(token.metadata.extra.as_deref().unwrap()).unwrap();
    assert_eq!(extra["content_hash"], HASH);
    assert_eq!(extra["fee"], "100000000000000000000000");
    assert_eq!(extra["payout_account"], "alice-payout.testnet");
    assert_eq!(extra["expiry_set_by"], "condex_ai");
    assert_eq!(
        extra["revenue_split"],
        serde_json::json!([{ "account_id": "alice-payout.testnet", "basis_points": 10000 }])
    );
    assert_eq!(extra["proof_count"], 0);

    // The times are numbers in the JSON a wallet receives, as NEP-177 defines them.
    let json = serde_json::to_value(&token).unwrap();
    assert_eq!(json["metadata"]["expires_at"], serde_json::json!(EXPIRY));
}

#[test]
fn an_unknown_token_reads_as_nothing_and_the_collection_has_a_name() {
    let contract = new_contract();
    assert!(contract.nft_token("ins_missing-v1".to_string()).is_none());
    let metadata = contract.nft_metadata();
    assert_eq!(metadata.spec, "nft-1.0.0");
    assert_eq!(metadata.name, "ConDex Thesis");
}

#[test]
#[should_panic(expected = "Only the operator can do this")]
fn only_the_operator_can_mint() {
    let mut contract = new_contract();
    call_as(&reporter(), T0, NOTHING);
    contract.mint_thesis(
        TOKEN.to_string(),
        alice(),
        alice(),
        FEE,
        HASH.to_string(),
        T0,
        EXPIRY,
        ExpirySetBy::Creator,
        None,
    );
}

#[test]
#[should_panic(expected = "Token ins_abc-v1 is already minted")]
fn a_token_is_minted_only_once() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    mint(&mut contract, TOKEN);
}

#[test]
#[should_panic(expected = "content_hash must be a SHA-256")]
fn a_fingerprint_must_be_a_sha256() {
    let mut contract = new_contract();
    call_as(&operator(), T0, NOTHING);
    contract.mint_thesis(
        TOKEN.to_string(),
        alice(),
        alice(),
        FEE,
        "not-a-hash".to_string(),
        T0,
        EXPIRY,
        ExpirySetBy::Creator,
        None,
    );
}

#[test]
#[should_panic(expected = "cannot be transferred")]
fn a_thesis_nft_cannot_be_transferred() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    call_as(&alice(), T0, NearToken::from_yoctonear(1));
    contract.nft_transfer(bob(), TOKEN.to_string(), None, None);
}

#[test]
#[should_panic(expected = "cannot be transferred")]
fn a_thesis_nft_cannot_be_transferred_with_a_call_either() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    call_as(&alice(), T0, NearToken::from_yoctonear(1));
    contract.nft_transfer_call(bob(), TOKEN.to_string(), None, None, String::new());
}

// ---- deposit and withdraw ----

#[test]
fn a_deposit_becomes_available() {
    let contract = with_thesis_and_deposit();
    let balance = contract.balance_of(bob());
    assert_eq!(balance.available, NearToken::from_near(1));
    assert_eq!(balance.reserved, NOTHING);
    assert_eq!(balance.earned_total, NOTHING);
}

#[test]
#[should_panic(expected = "Attach the NEAR you want to deposit")]
fn an_empty_deposit_is_refused() {
    let mut contract = new_contract();
    call_as(&bob(), T0, NOTHING);
    contract.deposit();
}

#[test]
fn a_withdrawal_sends_the_near_and_leaves_the_rest() {
    let mut contract = with_thesis_and_deposit();
    let amount = NearToken::from_millinear(400);
    call_as(&bob(), T0, NOTHING);
    let _ = contract.withdraw(amount);

    assert_eq!(available(&contract, bob()), NearToken::from_millinear(600));
    let receipts = get_created_receipts();
    let transfer = receipts
        .iter()
        .find(|r| r.receiver_id == bob())
        .expect("a receipt to Bob");
    assert!(transfer
        .actions
        .iter()
        .any(|a| matches!(a, MockAction::Transfer { deposit, .. } if *deposit == amount)));

    // The transfer arrived: the amount stays off the balance.
    call_as(&contract_account(), T0, NOTHING);
    assert!(contract.on_withdraw(bob(), amount, Ok(())));
    assert_eq!(available(&contract, bob()), NearToken::from_millinear(600));
}

#[test]
fn a_failed_withdrawal_puts_the_amount_back() {
    let mut contract = with_thesis_and_deposit();
    let amount = NearToken::from_millinear(400);
    call_as(&bob(), T0, NOTHING);
    let _ = contract.withdraw(amount);
    assert_eq!(available(&contract, bob()), NearToken::from_millinear(600));

    call_as(&contract_account(), T0, NOTHING);
    assert!(!contract.on_withdraw(bob(), amount, Err(PromiseError::Failed)));
    assert_eq!(available(&contract, bob()), NearToken::from_near(1));
}

#[test]
#[should_panic(expected = "is available to withdraw")]
fn nobody_withdraws_more_than_they_have() {
    let mut contract = with_thesis_and_deposit();
    call_as(&bob(), T0, NOTHING);
    let _ = contract.withdraw(NearToken::from_near(2));
}

#[test]
#[should_panic(expected = "is available to withdraw")]
fn a_reserved_fee_cannot_be_withdrawn() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    call_as(&bob(), T0 + HOUR, NOTHING);
    let _ = contract.withdraw(NearToken::from_near(1));
}

// ---- the trader approves the trade and its fee ----

#[test]
fn bob_approves_an_order_and_its_fee_is_reserved() {
    let mut contract = with_thesis_and_deposit();
    let view = reserve(&mut contract, ORDER, T0 + HOUR);

    assert_eq!(view.payer, bob());
    assert_eq!(view.token_id, TOKEN);
    assert_eq!(view.amount, FEE);
    assert_eq!(view.order_hash, order_hash(ORDER));
    assert_eq!(view.reserved_at, T0 + HOUR);
    assert_eq!(view.status, ReserveStatus::Reserved);

    let balance = contract.balance_of(bob());
    assert_eq!(balance.available, NearToken::from_millinear(900));
    assert_eq!(balance.reserved, FEE);
    assert_eq!(
        contract.get_reserve(ORDER.to_string()).unwrap().status,
        ReserveStatus::Reserved
    );
    assert!(contract.get_reserve("ord_other".to_string()).is_none());
}

#[test]
#[should_panic(expected = "only 0 is available")]
fn nobody_else_can_reserve_a_traders_funds() {
    let mut contract = with_thesis_and_deposit();
    // The operator has no way to name Bob as the payer: the reserve comes from the caller's own balance.
    call_as(&operator(), T0 + HOUR, NOTHING);
    contract.reserve_fee(ORDER.to_string(), TOKEN.to_string(), FEE, order_hash(ORDER));
}

#[test]
fn an_order_can_be_approved_until_the_moment_before_the_expiry() {
    let mut contract = with_thesis_and_deposit();
    assert_eq!(
        reserve(&mut contract, ORDER, EXPIRY - 1).status,
        ReserveStatus::Reserved
    );
}

#[test]
#[should_panic(expected = "has expired, so no new trade can be linked to it")]
fn an_order_cannot_be_approved_at_the_expiry() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, EXPIRY);
}

#[test]
#[should_panic(expected = "The fee of thesis ins_abc-v1 is 100000000000000000000000 yoctoNEAR")]
fn the_approved_fee_must_be_the_fee_on_the_token() {
    let mut contract = with_thesis_and_deposit();
    call_as(&bob(), T0 + HOUR, NOTHING);
    contract.reserve_fee(
        ORDER.to_string(),
        TOKEN.to_string(),
        NearToken::from_millinear(50),
        order_hash(ORDER),
    );
}

#[test]
#[should_panic(expected = "Deposit first")]
fn the_balance_must_cover_the_fee() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    reserve(&mut contract, ORDER, T0 + HOUR);
}

#[test]
#[should_panic(expected = "Order ord_1 already has a reserve")]
fn an_order_is_approved_only_once() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    reserve(&mut contract, ORDER, T0 + HOUR);
}

#[test]
#[should_panic(expected = "Token ins_missing-v1 does not exist")]
fn an_order_cannot_link_to_a_token_that_does_not_exist() {
    let mut contract = with_thesis_and_deposit();
    call_as(&bob(), T0 + HOUR, NOTHING);
    contract.reserve_fee(
        ORDER.to_string(),
        "ins_missing-v1".to_string(),
        FEE,
        order_hash(ORDER),
    );
}

// ---- settle on the first fill ----

#[test]
fn the_first_fill_credits_alice_once_and_records_the_proof_of_trade() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    assert!(settle(&mut contract, ORDER, T0 + 2 * HOUR));

    let alice_balance = contract.balance_of(alice());
    assert_eq!(alice_balance.available, FEE);
    assert_eq!(alice_balance.earned_total, FEE);
    let bob_balance = contract.balance_of(bob());
    assert_eq!(bob_balance.available, NearToken::from_millinear(900));
    assert_eq!(bob_balance.reserved, NOTHING);

    let view = contract.get_reserve(ORDER.to_string()).unwrap();
    assert_eq!(view.status, ReserveStatus::Settled);
    assert_eq!(view.receipt_id.as_deref(), Some("rcpt_ord_1"));
    assert_eq!(view.finalised_at, Some(T0 + 2 * HOUR));

    let proofs = contract.get_proofs(TOKEN.to_string(), None, None);
    assert_eq!(proofs.len(), 1);
    let recorded = &proofs[0];
    assert_eq!(recorded.order_id, ORDER);
    assert_eq!(recorded.token_id, TOKEN);
    assert_eq!(recorded.content_hash, HASH);
    assert_eq!(recorded.trader, bob());
    assert_eq!(recorded.role, TraderRole::Borrower);
    assert_eq!(
        (
            recorded.market.as_str(),
            recorded.side,
            recorded.quantity.as_str()
        ),
        ("ETH-USD", Side::Sell, "2")
    );
    assert_eq!(recorded.authorised_at, T0 + HOUR);
    assert_eq!(recorded.fill.price.as_deref(), Some("3500"));
    assert_eq!(recorded.fee_paid, FEE);
    assert!(recorded.closing_fills.is_empty());
    assert_eq!(recorded.proven_at, T0 + 2 * HOUR);

    // A second confirmation of the same fill changes nothing.
    assert!(!settle(&mut contract, ORDER, T0 + 3 * HOUR));
    assert_eq!(contract.balance_of(alice()).earned_total, FEE);
    assert_eq!(contract.get_proofs(TOKEN.to_string(), None, None).len(), 1);

    // Alice can withdraw what she earned.
    call_as(&alice(), T0 + 3 * HOUR, NOTHING);
    let _ = contract.withdraw(FEE);
    assert_eq!(available(&contract, alice()), NOTHING);
    assert_eq!(contract.balance_of(alice()).earned_total, FEE);
}

#[test]
fn an_order_approved_in_time_still_pays_after_the_expiry() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, EXPIRY - 60_000);
    assert!(settle(&mut contract, ORDER, EXPIRY + 60_000));
    assert_eq!(contract.balance_of(alice()).earned_total, FEE);
}

#[test]
fn the_fee_goes_to_the_payout_account_named_at_minting() {
    let mut contract = new_contract();
    let payout = account("alice-payout.testnet");
    call_as(&operator(), T0, NOTHING);
    contract.mint_thesis(
        TOKEN.to_string(),
        alice(),
        payout.clone(),
        FEE,
        HASH.to_string(),
        T0,
        EXPIRY,
        ExpirySetBy::Creator,
        None,
    );
    call_as(&bob(), T0, NearToken::from_near(1));
    contract.deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    settle(&mut contract, ORDER, T0 + 2 * HOUR);

    assert_eq!(contract.balance_of(payout).available, FEE);
    assert_eq!(contract.balance_of(alice()).available, NOTHING);
}

#[test]
#[should_panic(expected = "The order in this proof is not the one the trader approved")]
fn a_proof_for_a_different_order_than_bob_approved_is_refused() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    call_as(&reporter(), T0 + 2 * HOUR, NOTHING);
    // Bob approved a sale of 2. This proof says 20.
    contract.settle_fee(ORDER.to_string(), "rcpt_1".to_string(), proof("20"));
}

#[test]
#[should_panic(expected = "Only the reporter can do this")]
fn only_the_reporter_can_settle() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    call_as(&operator(), T0 + 2 * HOUR, NOTHING);
    contract.settle_fee(ORDER.to_string(), "rcpt_1".to_string(), proof("2"));
}

#[test]
#[should_panic(expected = "Order ord_1 has no fee reserve")]
fn an_order_nobody_approved_cannot_be_settled() {
    let mut contract = with_thesis_and_deposit();
    settle(&mut contract, ORDER, T0 + HOUR);
}

#[test]
fn proofs_are_listed_in_pages() {
    let mut contract = with_thesis_and_deposit();
    for order_id in ["ord_1", "ord_2", "ord_3"] {
        reserve(&mut contract, order_id, T0 + HOUR);
        settle(&mut contract, order_id, T0 + 2 * HOUR);
    }
    let ids = |from: Option<u32>, limit: Option<u32>| {
        contract
            .get_proofs(TOKEN.to_string(), from, limit)
            .into_iter()
            .map(|p| p.order_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(None, None), ["ord_1", "ord_2", "ord_3"]);
    assert_eq!(ids(Some(1), Some(1)), ["ord_2"]);
    assert_eq!(ids(Some(2), None), ["ord_3"]);
    assert!(ids(Some(3), None).is_empty());
    assert!(contract
        .get_proofs("ins_missing-v1".to_string(), None, None)
        .is_empty());

    let extra: serde_json::Value = serde_json::from_str(
        contract
            .nft_token(TOKEN.to_string())
            .unwrap()
            .metadata
            .extra
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(extra["proof_count"], 3);
}

// ---- release on no fill ----

#[test]
fn an_order_with_no_fills_returns_the_reserve_to_bob() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    call_as(&reporter(), T0 + 2 * HOUR, NOTHING);
    assert!(contract.release_fee(ORDER.to_string()));

    let balance = contract.balance_of(bob());
    assert_eq!(balance.available, NearToken::from_near(1));
    assert_eq!(balance.reserved, NOTHING);
    assert_eq!(contract.balance_of(alice()).earned_total, NOTHING);
    assert_eq!(
        contract.get_reserve(ORDER.to_string()).unwrap().status,
        ReserveStatus::Released
    );

    // Releasing again changes nothing.
    assert!(!contract.release_fee(ORDER.to_string()));
    assert_eq!(available(&contract, bob()), NearToken::from_near(1));
}

#[test]
#[should_panic(expected = "The reserve of order ord_1 was already released")]
fn a_released_reserve_cannot_be_settled() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    call_as(&reporter(), T0 + 2 * HOUR, NOTHING);
    contract.release_fee(ORDER.to_string());
    settle(&mut contract, ORDER, T0 + 3 * HOUR);
}

#[test]
#[should_panic(expected = "The reserve of order ord_1 was already settled")]
fn a_settled_reserve_cannot_be_released() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    settle(&mut contract, ORDER, T0 + 2 * HOUR);
    contract.release_fee(ORDER.to_string());
}

#[test]
#[should_panic(expected = "Only the reporter can do this")]
fn only_the_reporter_can_release() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    call_as(&bob(), T0 + 2 * HOUR, NOTHING);
    contract.release_fee(ORDER.to_string());
}

// ---- closing a trade ----

#[test]
fn closing_fills_are_added_to_the_proof_even_after_the_expiry() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    settle(&mut contract, ORDER, T0 + 2 * HOUR);

    assert!(close(&mut contract, ORDER, "evt_close_1", "1", "3450"));
    assert!(close(&mut contract, ORDER, "evt_close_2", "1", "3350.5"));
    // The same event again changes nothing.
    assert!(!close(&mut contract, ORDER, "evt_close_1", "1", "3450"));

    let proofs = contract.get_proofs(TOKEN.to_string(), None, None);
    let fills = &proofs[0].closing_fills;
    assert_eq!(fills.len(), 2);
    assert_eq!(
        (
            fills[0].event_id.as_str(),
            fills[0].quantity.as_str(),
            fills[0].price.as_str()
        ),
        ("evt_close_1", "1", "3450")
    );
    assert_eq!(
        (
            fills[1].event_id.as_str(),
            fills[1].quantity.as_str(),
            fills[1].price.as_str()
        ),
        ("evt_close_2", "1", "3350.5")
    );
    assert_eq!(fills[1].at, EXPIRY + HOUR);
    assert_eq!(fills[1].source, "simulated");

    // A close pays nothing.
    assert_eq!(contract.balance_of(alice()).earned_total, FEE);
    assert_eq!(available(&contract, bob()), NearToken::from_millinear(900));
}

#[test]
#[should_panic(expected = "Order ord_1 has no proof of trade")]
fn a_trade_that_never_filled_cannot_be_closed() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    close(&mut contract, ORDER, "evt_close_1", "2", "3400");
}

#[test]
#[should_panic(expected = "Event evt_close_1 was already used for another order")]
fn a_close_event_belongs_to_one_order() {
    let mut contract = with_thesis_and_deposit();
    for order_id in ["ord_1", "ord_2"] {
        reserve(&mut contract, order_id, T0 + HOUR);
        settle(&mut contract, order_id, T0 + 2 * HOUR);
    }
    close(&mut contract, "ord_1", "evt_close_1", "2", "3400");
    close(&mut contract, "ord_2", "evt_close_1", "2", "3400");
}

#[test]
#[should_panic(expected = "price must be greater than zero")]
fn a_closing_fill_needs_a_price_above_zero() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    settle(&mut contract, ORDER, T0 + 2 * HOUR);
    close(&mut contract, ORDER, "evt_close_1", "2", "0.00");
}

#[test]
#[should_panic(expected = "Only the reporter can do this")]
fn only_the_reporter_can_record_a_close() {
    let mut contract = with_thesis_and_deposit();
    reserve(&mut contract, ORDER, T0 + HOUR);
    settle(&mut contract, ORDER, T0 + 2 * HOUR);
    call_as(&bob(), T0 + 3 * HOUR, NOTHING);
    contract.record_close(
        ORDER.to_string(),
        "evt_close_1".to_string(),
        "2".to_string(),
        "3400".to_string(),
        T0 + 3 * HOUR,
        "simulated".to_string(),
    );
}

// ---- subscriptions ----

#[test]
fn bob_subscribes_and_condex_is_credited() {
    let mut contract = new_contract();
    let before = contract.subscription_of(bob());
    assert_eq!((before.subscribed_until, before.active), (0, false));
    assert_eq!((before.price, before.period), (PRICE, PERIOD));

    call_as(&bob(), T0, PRICE);
    let view = contract.subscribe();
    assert_eq!(view.subscribed_until, T0 + PERIOD);
    assert!(view.active);

    let income = contract.balance_of(owner());
    assert_eq!(income.available, PRICE);
    assert_eq!(income.earned_total, PRICE);

    // It lapses at the end of the period.
    call_as(&bob(), T0 + PERIOD, NOTHING);
    assert!(!contract.subscription_of(bob()).active);
}

#[test]
fn a_renewal_counts_from_the_end_of_the_current_period_or_from_now() {
    let mut contract = new_contract();
    call_as(&bob(), T0, PRICE);
    contract.subscribe();

    // Renewed early: the new period starts where the current one ends.
    call_as(&bob(), T0 + HOUR, PRICE);
    assert_eq!(contract.subscribe().subscribed_until, T0 + 2 * PERIOD);

    // Renewed after it lapsed: the new period starts now.
    let later = T0 + 3 * PERIOD;
    call_as(&bob(), later, PRICE);
    assert_eq!(contract.subscribe().subscribed_until, later + PERIOD);
    assert_eq!(
        contract.balance_of(owner()).earned_total,
        PRICE.saturating_mul(3)
    );
}

#[test]
#[should_panic(
    expected = "One subscription period costs exactly 2000000000000000000000000 yoctoNEAR"
)]
fn a_subscription_costs_exactly_the_price() {
    let mut contract = new_contract();
    call_as(&bob(), T0, NearToken::from_near(1));
    contract.subscribe();
}

#[test]
fn the_owner_sets_new_terms_for_later_subscriptions() {
    let mut contract = new_contract();
    call_as(&bob(), T0, PRICE);
    contract.subscribe();

    let new_price = NearToken::from_near(5);
    call_as(&owner(), T0 + HOUR, NOTHING);
    contract.set_subscription_terms(new_price, HOUR);

    let view = contract.subscription_of(bob());
    assert_eq!((view.price, view.period), (new_price, HOUR));
    // What Bob already bought keeps its end date.
    assert_eq!(view.subscribed_until, T0 + PERIOD);

    let carol = account("carol.testnet");
    call_as(&carol, T0 + HOUR, new_price);
    assert_eq!(contract.subscribe().subscribed_until, T0 + 2 * HOUR);
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn only_the_owner_sets_the_terms() {
    let mut contract = new_contract();
    call_as(&operator(), T0, NOTHING);
    contract.set_subscription_terms(NOTHING, HOUR);
}

// ---- the order fingerprint and input checks ----

#[test]
fn the_order_fingerprint_is_a_sha256_anyone_can_rebuild() {
    // SHA-256 of "condex-order-v1|ord_1|ins_abc-v1|ETH-USD|sell|2", computed outside the contract.
    assert_eq!(
        order_fingerprint("ord_1", "ins_abc-v1", "ETH-USD", Side::Sell, "2"),
        "007a3e36f2664d5345d9bcc73ca0ee2847df4d9d73ee7641dfb63125b3263eca"
    );
    assert_ne!(
        order_fingerprint("ord_1", TOKEN, "ETH-USD", Side::Buy, "2"),
        order_hash("ord_1")
    );
    assert_ne!(
        order_fingerprint("ord_1", TOKEN, "ETH-USD", Side::Sell, "20"),
        order_hash("ord_1")
    );
    assert_ne!(
        order_fingerprint("ord_1", TOKEN, "BTC-USD", Side::Sell, "2"),
        order_hash("ord_1")
    );
}

#[test]
fn decimals_follow_the_api_format() {
    call_as(&owner(), T0, NOTHING);
    for good in ["1", "1.5", "3350.5", "0.000000000000000001", "100"] {
        assert_positive_decimal(good, "value");
    }
    for bad in [
        "",
        "0",
        "0.0",
        "1.",
        ".5",
        "-1",
        "1e3",
        "1,5",
        " 1",
        "1.1234567890123456789",
    ] {
        let refused = std::panic::catch_unwind(|| assert_positive_decimal(bad, "value")).is_err();
        assert!(refused, "{bad:?} should be refused");
    }
}

#[test]
fn sources_and_ids_are_checked() {
    call_as(&owner(), T0, NOTHING);
    for good in ["simulated", "venue:acme", "venue:acme-2.test_1"] {
        assert_source(good);
    }
    for bad in ["", "live", "venue:", "venue:ACME", "simulated "] {
        assert!(
            std::panic::catch_unwind(|| assert_source(bad)).is_err(),
            "{bad:?} should be refused"
        );
    }
    assert_id("ins_Ab3-xyz_9-v12", "id");
    for bad in ["", "has|bar", "has space", &"x".repeat(129)] {
        assert!(
            std::panic::catch_unwind(|| assert_id(bad, "id")).is_err(),
            "{bad:?} should be refused"
        );
    }
}

// ---- the evaluation, recorded on the token after the expiry ----

/// Records a target_hit evaluation of `TOKEN` as `caller` at `now`.
fn evaluate(contract: &mut Contract, caller: &AccountId, now: u64) -> bool {
    call_as(caller, now, NOTHING);
    contract.record_evaluation(
        TOKEN.to_string(),
        Outcome::TargetHit,
        Some(true),
        Some("3500".to_string()),
        Some("3920".to_string()),
        Some(T0 + HOUR),
        Some(T0 + 20 * HOUR),
        None,
        3,
        "simulated".to_string(),
    )
}

#[test]
fn after_the_expiry_the_reporter_records_the_evaluation_on_the_token() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    assert_eq!(contract.get_evaluation(TOKEN.to_string()), None);

    assert!(evaluate(&mut contract, &reporter(), EXPIRY + HOUR));
    let ev = contract.get_evaluation(TOKEN.to_string()).unwrap();
    assert_eq!(ev.outcome, Outcome::TargetHit);
    assert_eq!(ev.conditions_met, Some(true));
    assert_eq!(ev.deadline, EXPIRY);
    assert_eq!(ev.evaluated_at, EXPIRY + HOUR);
    assert!(get_logs().iter().any(|l| l.contains("thesis_evaluated")));

    // It is part of the token itself, for wallets and explorers.
    let token = contract.nft_token(TOKEN.to_string()).unwrap();
    let extra: serde_json::Value = serde_json::from_str(&token.metadata.extra.unwrap()).unwrap();
    assert_eq!(extra["evaluation"]["outcome"], "target_hit");
    assert_eq!(extra["evaluation"]["conditions_met"], true);
}

#[test]
fn an_evaluation_is_recorded_once_and_never_replaced() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    assert!(evaluate(&mut contract, &reporter(), EXPIRY));
    call_as(&reporter(), EXPIRY + 2 * HOUR, NOTHING);
    let again = contract.record_evaluation(
        TOKEN.to_string(), Outcome::Invalidated, Some(false), None, None, None, None, None, 0, "simulated".to_string(),
    );
    assert!(!again);
    assert_eq!(contract.get_evaluation(TOKEN.to_string()).unwrap().outcome, Outcome::TargetHit);
}

#[test]
#[should_panic(expected = "cannot be evaluated before its deadline")]
fn nothing_is_evaluated_before_the_expiry() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    evaluate(&mut contract, &reporter(), EXPIRY - 1);
}

/// Mints `TOKEN` with an evaluation deadline of `EXPIRY + 2 * HOUR`.
fn mint_with_later_deadline(contract: &mut Contract, deadline: u64) {
    call_as(&operator(), T0, NOTHING);
    contract.mint_thesis(
        TOKEN.to_string(), alice(), alice(), FEE, HASH.to_string(), T0, EXPIRY, ExpirySetBy::Creator, Some(deadline),
    );
}

#[test]
fn a_later_evaluation_deadline_moves_the_evaluation_but_not_the_expiry() {
    let mut contract = new_contract();
    mint_with_later_deadline(&mut contract, EXPIRY + 2 * HOUR);
    let token = contract.nft_token(TOKEN.to_string()).unwrap();
    assert_eq!(token.metadata.expires_at, Some(EXPIRY));
    assert!(token.metadata.extra.unwrap().contains(&format!("\"evaluation_deadline\":{}", EXPIRY + 2 * HOUR)));
    // The deadline is later than the event times the evaluation reports, and the evaluation records it.
    assert!(evaluate(&mut contract, &reporter(), EXPIRY + 2 * HOUR));
    assert_eq!(contract.get_evaluation(TOKEN.to_string()).unwrap().deadline, EXPIRY + 2 * HOUR);
}

#[test]
#[should_panic(expected = "cannot be evaluated before its deadline")]
fn nothing_is_evaluated_between_the_expiry_and_a_later_evaluation_deadline() {
    let mut contract = new_contract();
    mint_with_later_deadline(&mut contract, EXPIRY + 2 * HOUR);
    evaluate(&mut contract, &reporter(), EXPIRY + HOUR);
}

#[test]
fn without_one_the_evaluation_deadline_is_the_expiry() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    let extra = contract.nft_token(TOKEN.to_string()).unwrap().metadata.extra.unwrap();
    assert!(extra.contains(&format!("\"evaluation_deadline\":{EXPIRY}")));
    assert!(evaluate(&mut contract, &reporter(), EXPIRY));
    assert_eq!(contract.get_evaluation(TOKEN.to_string()).unwrap().deadline, EXPIRY);
}

#[test]
#[should_panic(expected = "evaluation_deadline cannot be before expires_at")]
fn an_evaluation_deadline_cannot_be_before_the_expiry() {
    let mut contract = new_contract();
    mint_with_later_deadline(&mut contract, EXPIRY - 1);
}

#[test]
#[should_panic(expected = "Only the reporter can do this")]
fn only_the_reporter_records_an_evaluation() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    evaluate(&mut contract, &operator(), EXPIRY + HOUR);
}

#[test]
#[should_panic(expected = "Token ins_nope-v1 does not exist")]
fn an_unknown_token_cannot_be_evaluated() {
    let mut contract = new_contract();
    call_as(&reporter(), EXPIRY, NOTHING);
    contract.record_evaluation(
        "ins_nope-v1".to_string(), Outcome::NoData, None, None, None, None, None, None, 0, "simulated".to_string(),
    );
}

#[test]
#[should_panic(expected = "conditions_met does not agree with the outcome")]
fn the_outcome_decides_whether_the_conditions_were_met() {
    let mut contract = new_contract();
    mint(&mut contract, TOKEN);
    call_as(&reporter(), EXPIRY, NOTHING);
    contract.record_evaluation(
        TOKEN.to_string(), Outcome::Invalidated, Some(true), None, None, None, None, None, 2, "simulated".to_string(),
    );
}

#[test]
fn evaluation_prices_times_and_sources_are_checked() {
    // The mocked chain keeps its storage within a test, so each case gets its own token.
    let mut contract = new_contract();
    for (i, (price, at, source)) in [
        (Some("-1"), None, "simulated"),
        (None, Some(EXPIRY + 1), "simulated"),
        (None, None, "venue:acme"),
    ]
    .into_iter()
    .enumerate()
    {
        let token = format!("ins_case{i}-v1");
        mint(&mut contract, &token);
        call_as(&reporter(), EXPIRY, NOTHING);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.record_evaluation(
                token.clone(), Outcome::TargetMissed, Some(false), price.map(String::from), None, at, None, None, 1,
                source.to_string(),
            )
        }));
        assert!(result.is_err(), "{price:?} {at:?} {source} should be refused");
    }
    // Every outcome agrees with its own conditions_met.
    for outcome in [Outcome::NotTriggered, Outcome::AlreadyReached, Outcome::NoData] {
        assert_eq!(outcome.conditions_met(), None);
    }
}
