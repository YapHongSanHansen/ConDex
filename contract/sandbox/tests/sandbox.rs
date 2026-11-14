//! The ConDex contract on a local NEAR node, with real accounts and real NEAR moving between them.
//!
//! The unit tests in `contract/src/tests.rs` run each function on the SDK's mocked blockchain, which does not
//! move NEAR between accounts. Here the built contract (`contract/target/near/condex_contract.wasm`, from
//! `cargo near build non-reproducible-wasm --locked`) is deployed to a sandbox node, and wallets are checked
//! before and after: deposits, the subscription, the fee to the creator, refunds and withdrawals.
//!
//! Run from `contract/sandbox`: `cargo test -- --nocapture`. The first run downloads the sandbox node.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const WASM: &str = "../target/near/condex_contract.wasm";
/// The build of the contract as first deployed (commit 361e35c), kept to test upgrading from it.
const WASM_V1: &str = "../target/near/condex_contract_v1.wasm";
const DAY_MS: u64 = 86_400_000;

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

fn millinear(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

/// The order fingerprint the trader approves, as docs/near-contract.md defines it.
fn order_hash(order_id: &str, token_id: &str, market: &str, side: &str, quantity: &str) -> String {
    let text = format!("condex-order-v1|{order_id}|{token_id}|{market}|{side}|{quantity}");
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A wallet's balance once unused gas has been refunded, which NEAR does a block or two after a call.
async fn wallet(worker: &Worker<Sandbox>, account: &Account) -> anyhow::Result<u128> {
    worker.fast_forward(3).await?;
    Ok(worker.view_account(account.id()).await?.balance.as_yoctonear())
}

async fn now_ms(worker: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

async fn balance(contract: &Contract, account: &Account) -> anyhow::Result<Value> {
    Ok(contract.view("balance_of").args_json(json!({ "account_id": account.id() })).await?.json()?)
}

fn yocto(v: &Value) -> u128 {
    v.as_str().expect("an amount as text").parse().expect("a yoctoNEAR number")
}

fn failure(outcome: ExecutionFinalResult) -> String {
    assert!(outcome.is_failure(), "expected the call to fail");
    format!("{:?}", outcome.into_result().unwrap_err())
}

/// Gas costs a little NEAR, so a wallet's change is checked to within 0.01 NEAR.
fn assert_about(actual: i128, expected: i128, what: &str) {
    let slack = millinear(10).as_yoctonear() as i128;
    assert!((actual - expected).abs() <= slack, "{what}: changed by {actual} yocto, expected about {expected}");
}

struct Setup {
    worker: Worker<Sandbox>,
    contract: Contract,
    owner: Account,
    operator: Account,
    reporter: Account,
    alice: Account,
    bob: Account,
}

async fn setup() -> anyhow::Result<Setup> {
    setup_with(WASM).await
}

async fn setup_with(path: &str) -> anyhow::Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}. Build it first with cargo near."))?;
    let contract = worker.dev_deploy(&wasm).await?;
    let root = worker.root_account()?;
    let mut accounts = Vec::new();
    for name in ["owner", "operator", "reporter", "alice", "bob"] {
        accounts.push(root.create_subaccount(name).initial_balance(near(20)).transact().await?.into_result()?);
    }
    let [owner, operator, reporter, alice, bob]: [Account; 5] = accounts.try_into().unwrap();
    contract
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(), "operator_id": operator.id(), "reporter_id": reporter.id(),
            "subscription_price": near(1), "subscription_period": 30 * DAY_MS,
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Setup { worker, contract, owner, operator, reporter, alice, bob })
}

async fn mint(s: &Setup, token_id: &str, expires_in_ms: u64) -> anyhow::Result<()> {
    let now = now_ms(&s.worker).await?;
    s.operator
        .call(s.contract.id(), "mint_thesis")
        .args_json(json!({
            "token_id": token_id, "owner": s.alice.id(), "payout_account": s.alice.id(), "fee": millinear(100),
            "content_hash": "a".repeat(64), "issued_at": now, "expires_at": now + expires_in_ms, "expiry_set_by": "creator",
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn reserve(s: &Setup, who: &Account, order_id: &str, token_id: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(s.contract.id(), "reserve_fee")
        .args_json(json!({
            "order_id": order_id, "token_id": token_id, "fee": millinear(100),
            "order_hash": order_hash(order_id, token_id, "ETH-USD", "sell", "2"),
        }))
        .transact()
        .await?)
}

fn proof(event_id: &str, at: u64) -> Value {
    json!({
        "market": "ETH-USD", "side": "sell", "quantity": "2",
        "fill": { "event_id": event_id, "at": at, "price": "3500", "quantity": "2", "source": "simulated" },
    })
}

#[tokio::test]
async fn real_near_moves_between_accounts() -> anyhow::Result<()> {
    let s = setup().await?;
    let token = "ins_sandbox-v1";
    mint(&s, token, DAY_MS).await?;
    println!("minted {token} on {}", s.contract.id());

    // Bob deposits 2 NEAR from his wallet into the contract.
    let bob_wallet = wallet(&s.worker, &s.bob).await?;
    s.bob.call(s.contract.id(), "deposit").deposit(near(2)).transact().await?.into_result()?;
    assert_about(wallet(&s.worker, &s.bob).await? as i128 - bob_wallet as i128, -(near(2).as_yoctonear() as i128), "Bob's wallet after depositing");
    assert_eq!(yocto(&balance(&s.contract, &s.bob).await?["available"]), near(2).as_yoctonear());

    // The subscription needs exactly the price attached, and is credited to the owner (ConDex).
    let wrong = s.bob.call(s.contract.id(), "subscribe").deposit(millinear(500)).transact().await?;
    assert!(failure(wrong).contains("costs exactly"));
    let sub: Value = s.bob.call(s.contract.id(), "subscribe").deposit(near(1)).transact().await?.into_result()?.json()?;
    assert_eq!(sub["active"], true);
    assert_eq!(yocto(&balance(&s.contract, &s.owner).await?["available"]), near(1).as_yoctonear());
    let view: Value = s.contract.view("subscription_of").args_json(json!({ "account_id": s.bob.id() })).await?.json()?;
    assert_eq!(view["active"], true);
    println!("Bob subscribed until {} (ms)", view["subscribed_until"]);

    // Only Bob can reserve Bob's funds: the reserve is always taken from the caller's own balance.
    let alice_tries = reserve(&s, &s.alice, "ord_alice", token).await?;
    assert!(failure(alice_tries).contains("Deposit first"), "Alice has no deposit, so she cannot reserve anything");
    let r: Value = reserve(&s, &s.bob, "ord_1", token).await?.into_result()?.json()?;
    println!("reserved: {r}");
    let bob_bal = balance(&s.contract, &s.bob).await?;
    assert_eq!(yocto(&bob_bal["available"]), near(2).as_yoctonear() - millinear(100).as_yoctonear());
    assert_eq!(yocto(&bob_bal["reserved"]), millinear(100).as_yoctonear());

    // Only the reporter settles. The proof must match the order Bob approved.
    let now = now_ms(&s.worker).await?;
    let by_operator = s.operator.call(s.contract.id(), "settle_fee")
        .args_json(json!({ "order_id": "ord_1", "receipt_id": "rcpt_1", "proof": proof("evt_1", now) })).transact().await?;
    assert!(failure(by_operator).contains("reporter"));
    let mut changed = proof("evt_1", now);
    changed["quantity"] = json!("5");
    let tampered = s.reporter.call(s.contract.id(), "settle_fee")
        .args_json(json!({ "order_id": "ord_1", "receipt_id": "rcpt_1", "proof": changed })).transact().await?;
    assert!(failure(tampered).contains("not the one the trader approved"));
    let settled: bool = s.reporter.call(s.contract.id(), "settle_fee")
        .args_json(json!({ "order_id": "ord_1", "receipt_id": "rcpt_1", "proof": proof("evt_1", now) }))
        .transact().await?.into_result()?.json()?;
    assert!(settled);
    let again: bool = s.reporter.call(s.contract.id(), "settle_fee")
        .args_json(json!({ "order_id": "ord_1", "receipt_id": "rcpt_1", "proof": proof("evt_1", now) }))
        .transact().await?.into_result()?.json()?;
    assert!(!again, "a second settle changes nothing");
    assert_eq!(yocto(&balance(&s.contract, &s.alice).await?["available"]), millinear(100).as_yoctonear());
    assert_eq!(yocto(&balance(&s.contract, &s.bob).await?["reserved"]), 0);

    // The close is recorded on the proof of trade.
    let closed: bool = s.reporter.call(s.contract.id(), "record_close")
        .args_json(json!({ "order_id": "ord_1", "event_id": "evt_close_1", "quantity": "2", "price": "3400",
            "closed_at": now_ms(&s.worker).await?, "source": "simulated" }))
        .transact().await?.into_result()?.json()?;
    assert!(closed);
    let proofs: Value = s.contract.view("get_proofs").args_json(json!({ "token_id": token, "from_index": 0, "limit": 10 })).await?.json()?;
    println!("proofs of trade: {proofs}");
    assert_eq!(proofs.as_array().unwrap().len(), 1);

    // A second order that never fills: the reserve goes back to Bob.
    reserve(&s, &s.bob, "ord_2", token).await?.into_result()?;
    let released: bool = s.reporter.call(s.contract.id(), "release_fee").args_json(json!({ "order_id": "ord_2" }))
        .transact().await?.into_result()?.json()?;
    assert!(released);
    let late = s.reporter.call(s.contract.id(), "settle_fee")
        .args_json(json!({ "order_id": "ord_2", "receipt_id": "rcpt_2", "proof": proof("evt_2", now) })).transact().await?;
    assert!(failure(late).contains("already released"));

    // Withdrawals send real NEAR to each wallet.
    for (who, amount, what) in [
        (&s.alice, millinear(100), "Alice withdraws her fee"),
        (&s.owner, near(1), "ConDex (owner) withdraws the subscription"),
        // The subscription was paid with NEAR attached to the call, not from the deposit: 2 - 0.1 fee is left.
        (&s.bob, millinear(1_900), "Bob withdraws what is left"),
    ] {
        let before = wallet(&s.worker, who).await?;
        who.call(s.contract.id(), "withdraw").args_json(json!({ "amount": amount })).max_gas().transact().await?.into_result()?;
        let after = wallet(&s.worker, who).await?;
        assert_about(after as i128 - before as i128, amount.as_yoctonear() as i128, what);
        println!("{what}: wallet +{} yocto", after as i128 - before as i128);
    }
    let too_much = s.bob.call(s.contract.id(), "withdraw").args_json(json!({ "amount": millinear(1) })).max_gas().transact().await?;
    assert!(failure(too_much).contains("available"));
    for who in [&s.alice, &s.owner, &s.bob] {
        assert_eq!(yocto(&balance(&s.contract, who).await?["available"]), 0, "{} has nothing left in the contract", who.id());
    }
    Ok(())
}

#[tokio::test]
async fn the_chain_clock_stops_approvals_at_the_expiry() -> anyhow::Result<()> {
    let s = setup().await?;
    let token = "ins_expiring-v1";
    mint(&s, token, 5_000).await?; // expires 5 seconds after the block it was minted in
    s.bob.call(s.contract.id(), "deposit").deposit(near(1)).transact().await?.into_result()?;
    let expires_at = now_ms(&s.worker).await? + 5_000;

    s.worker.fast_forward(100).await?;
    let now = now_ms(&s.worker).await?;
    println!("block time moved {} ms past the expiry", now as i64 - expires_at as i64);
    if now < expires_at {
        println!("the sandbox clock did not pass the expiry; nothing to check");
        return Ok(());
    }
    let late = reserve(&s, &s.bob, "ord_late", token).await?;
    assert!(failure(late).contains("has expired, so no new trade can be linked"));
    println!("late approval refused: the thesis has expired");
    assert_eq!(yocto(&balance(&s.contract, &s.bob).await?["reserved"]), 0);
    Ok(())
}

/// Redeploying the new code over the deployed one keeps every token, balance, reserve and proof, and adds the
/// evaluation. This is what upgrading dryward2518.testnet does.
#[tokio::test]
async fn upgrading_keeps_the_state_and_adds_evaluations() -> anyhow::Result<()> {
    if !std::path::Path::new(WASM_V1).exists() {
        println!("{WASM_V1} not found; skipping the upgrade test");
        return Ok(());
    }
    let s = setup_with(WASM_V1).await?;
    let token = "ins_upgrade-v1";
    mint(&s, token, 5_000).await?; // expires 5 seconds after it is minted
    mint(&s, "ins_later-v1", DAY_MS).await?;
    s.bob.call(s.contract.id(), "deposit").deposit(near(1)).transact().await?.into_result()?;
    reserve(&s, &s.bob, "ord_up", token).await?.into_result()?;
    let now = now_ms(&s.worker).await?;
    s.reporter.call(s.contract.id(), "settle_fee")
        .args_json(json!({ "order_id": "ord_up", "receipt_id": "rcpt_up", "proof": proof("evt_up", now) }))
        .transact().await?.into_result()?;
    let before = (
        s.contract.view("get_proofs").args_json(json!({ "token_id": token, "from_index": 0, "limit": 5 })).await?.json::<Value>()?,
        balance(&s.contract, &s.alice).await?,
        balance(&s.contract, &s.bob).await?,
    );

    // The upgrade: the new code, no init call.
    let new_wasm = std::fs::read(WASM)?;
    s.contract.as_account().deploy(&new_wasm).await?.into_result()?;
    let after = (
        s.contract.view("get_proofs").args_json(json!({ "token_id": token, "from_index": 0, "limit": 5 })).await?.json::<Value>()?,
        balance(&s.contract, &s.alice).await?,
        balance(&s.contract, &s.bob).await?,
    );
    assert_eq!(before, after, "the proofs and balances read the same after the upgrade");
    let sub: Value = s.contract.view("subscription_of").args_json(json!({ "account_id": s.bob.id() })).await?.json()?;
    assert_eq!(sub["price"], near(1).as_yoctonear().to_string());

    let evaluate = |token_id: &'static str| {
        s.reporter.call(s.contract.id(), "record_evaluation").args_json(json!({
            "token_id": token_id, "outcome": "target_hit", "conditions_met": true, "reference_price": "3500",
            "final_price": "3400", "entered_at": null, "target_hit_at": null, "invalidated_at": null, "prices_used": 2,
            "source": "simulated",
        }))
    };
    // Before its expiry, by the chain's clock, a thesis cannot be evaluated.
    assert!(failure(evaluate("ins_later-v1").transact().await?).contains("cannot be evaluated before its deadline"));

    s.worker.fast_forward(100).await?;
    let first: bool = evaluate(token).transact().await?.into_result()?.json()?;
    let second: bool = evaluate(token).transact().await?.into_result()?.json()?;
    assert!(first && !second, "recorded once, never replaced");
    let ev: Value = s.contract.view("get_evaluation").args_json(json!({ "token_id": token })).await?.json()?;
    assert_eq!(ev["outcome"], "target_hit");
    let nft: Value = s.contract.view("nft_token").args_json(json!({ "token_id": token })).await?.json()?;
    let extra: Value = serde_json::from_str(nft["metadata"]["extra"].as_str().unwrap())?;
    assert_eq!(extra["evaluation"]["conditions_met"], true);
    assert_eq!(extra["proof_count"], 1);
    println!("upgraded: proofs and balances kept; evaluation recorded on the token: {}", extra["evaluation"]);
    Ok(())
}
