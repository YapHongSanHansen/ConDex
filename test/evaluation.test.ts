import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import { sweepEvaluations } from "../src/services/evaluationSweep.ts";
import { ETH_THESIS, setupAliceAndBob, startServer } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;

// Only Date is mocked, so a thesis can reach its deadline without waiting; network timers stay real.
const T0 = Date.parse("2030-03-01T00:00:00.000Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000).toISOString();
const DEADLINE = at(24);
const afterDeadline = () => mock.timers.setTime(T0 + 25 * 3_600_000);

/** Long ETH-USD: enter at 3600, wrong below 3450, right at 3900. */
const LONG = {
  ...ETH_THESIS, title: "ETH bullish", direction: "long", expires_at: DEADLINE, expiry_date: undefined,
  entry: "A 1-hour close above 3,600.", invalidation: "A 4-hour close below 3,450.", target: "3,900.",
  entry_price: "3600", invalidation_price: "3450", target_price: "3900",
};

let s: Awaited<ReturnType<typeof setupAliceAndBob>>;

after(() => srv.close());
beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  await api("POST", "/v1/dev/reset");
  s = await setupAliceAndBob(api);
});
afterEach(() => mock.timers.reset());

async function publish(body: Record<string, unknown> = {}) {
  const r = await api("POST", "/v1/insights", { key: s.alicePublish, body: { ...LONG, ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token_id as string;
}

async function prices(points: Array<[hours: number, price: string]>, market = "ETH-USD") {
  for (const [h, price] of points) {
    assert.equal((await api("POST", `/v1/sim/market/${market}/prices`, { body: { price, at: at(h) } })).status, 201);
  }
}

const evaluation = async (tokenId: string) => (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.evaluation;

describe("price levels", () => {
  test("are optional, recorded with the conditions and covered by the fingerprint", async () => {
    const tokenId = await publish();
    const read = (await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead })).body;
    assert.equal(read.conditions.entry_price, "3600");
    assert.equal(read.conditions.invalidation_price, "3450");
    assert.equal(read.conditions.target_price, "3900");
    assert.equal(read.integrity.matches, true);
    srv.ctx.db.prepare("UPDATE insight_versions SET target_price = '5000' WHERE token_id = ?").run(tokenId);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead })).body.integrity.matches, false);
  });

  test("must agree with the direction", async () => {
    const cases: Array<Record<string, unknown>> = [
      { invalidation_price: "3700" },                                   // long: invalidation above entry
      { target_price: "3500" },                                         // long: target below entry
      { direction: "short" },                                           // short with long levels
      { entry_price: "abc" },
    ];
    for (const body of cases) {
      const r = await api("POST", "/v1/insights", { key: s.alicePublish, body: { ...LONG, ...body } });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    await publish({ direction: "short", entry_price: "3600", invalidation_price: "3700", target_price: "3300" });
  });
});

describe("the evaluation deadline", () => {
  test("is separate from the expiry: no new trade after the expiry, but prices count up to the deadline", async () => {
    const tokenId = await publish({ evaluation_deadline: at(48) });
    const proof = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proof_of_thesis;
    assert.equal(proof.expires_at, DEADLINE);
    assert.equal(proof.evaluation_deadline, at(48));
    // The target is reached after the expiry but before the evaluation deadline.
    await prices([[-1, "3550"], [2, "3610"], [30, "3910"]]);
    afterDeadline(); // 25h: expired, but not yet due for evaluation
    assert.deepEqual(await evaluation(tokenId), { status: "pending", deadline: at(48), source: "simulated" });
    mock.timers.setTime(T0 + 49 * 3_600_000);
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "target_hit");
    assert.equal(ev.deadline, at(48));
  });

  test("is covered by the fingerprint", async () => {
    const tokenId = await publish({ evaluation_deadline: at(48) });
    srv.ctx.db.prepare("UPDATE insight_versions SET evaluation_deadline = ? WHERE token_id = ?").run(at(72), tokenId);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead })).body.integrity.matches, false);
  });

  test("accepts a date, and refuses one before the expiry or too long after it", async () => {
    const day = await publish({ evaluation_deadline: "2030-03-03" });
    assert.equal((await api("GET", `/v1/tokens/${day}/proof`)).body.proof_of_thesis.evaluation_deadline, "2030-03-03T23:59:59.000Z");
    for (const evaluation_deadline of [at(23), "2030-06-01", "soon"]) {
      const r = await api("POST", "/v1/insights", { key: s.alicePublish, body: { ...LONG, evaluation_deadline } });
      assert.equal(r.status, 400, evaluation_deadline);
      assert.equal(r.body.error.code, "invalid_evaluation_deadline");
    }
  });

  test("the sweep waits for it", async () => {
    const tokenId = await publish({ evaluation_deadline: at(48) });
    mock.timers.setTime(T0 + 30 * 3_600_000);
    assert.equal(sweepEvaluations(srv.ctx), 0);
    mock.timers.setTime(T0 + 49 * 3_600_000);
    assert.equal(sweepEvaluations(srv.ctx), 1);
    assert.equal((await evaluation(tokenId)).status, "evaluated");
  });
});

describe("ConDex evaluates a thesis against market data", () => {
  test("before the deadline it is pending; after, the target reached first means the conditions were met", async () => {
    const tokenId = await publish();
    await prices([[-1, "3550"], [2, "3610"], [3, "3700"], [4, "3910"], [5, "3300"]]);
    assert.deepEqual(await evaluation(tokenId), { status: "pending", deadline: DEADLINE, source: "simulated" });

    afterDeadline();
    const ev = await evaluation(tokenId);
    assert.equal(ev.status, "evaluated");
    assert.equal(ev.outcome, "target_hit");
    assert.equal(ev.conditions_met, true);
    assert.equal(ev.reference_price, "3550");
    assert.equal(ev.entered_at, at(2));
    assert.equal(ev.target_hit_at, at(4));
    assert.equal(ev.invalidated_at, null);
    assert.equal(ev.source, "simulated");
  });

  test("the invalidation counts from the start, the target only after the entry", async () => {
    const tokenId = await publish();
    // 3950 is past the target, but the entry (3600) was never reached on the way: 3440 invalidates first.
    await prices([[-1, "3550"], [1, "3440"], [2, "3950"]]);
    afterDeadline();
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "invalidated");
    assert.equal(ev.conditions_met, false);
    assert.equal(ev.invalidated_at, at(1));
    assert.equal(ev.entered_at, null);
  });

  test("an entry never reached is not judged; an entry without the target is not met", async () => {
    const notTriggered = await publish({ entry_price: "3700", invalidation_price: "3450", target_price: "3900" });
    const missed = await publish();
    await prices([[-1, "3550"], [2, "3650"], [3, "3610"]]);
    afterDeadline();
    const a = await evaluation(notTriggered);
    assert.equal(a.outcome, "not_triggered");
    assert.equal(a.conditions_met, null);
    const b = await evaluation(missed);
    assert.equal(b.outcome, "target_missed");
    assert.equal(b.conditions_met, false);
    assert.equal(b.final_price, "3610");
  });

  test("without price levels, the direction at the deadline decides", async () => {
    const noLevels = { entry_price: undefined, invalidation_price: undefined, target_price: undefined };
    const long = await publish(noLevels);
    const short = await publish({ ...noLevels, direction: "short" });
    await prices([[-1, "3500"], [12, "3600"], [30, "3000"]]); // the price after the deadline is ignored
    afterDeadline();
    assert.equal((await evaluation(long)).outcome, "in_direction");
    assert.equal((await evaluation(long)).final_price, "3600");
    assert.equal((await evaluation(short)).outcome, "against_direction");
  });

  test("with no market data the thesis is not judged", async () => {
    const tokenId = await publish({ market: "SOL-USD" });
    afterDeadline();
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "no_data");
    assert.equal(ev.conditions_met, null);
  });

  test("the evaluation is recorded once and does not change when prices are added later", async () => {
    const tokenId = await publish();
    await prices([[-1, "3550"], [2, "3610"], [4, "3910"]]);
    afterDeadline();
    const first = await evaluation(tokenId);
    await prices([[1, "3400"]]);
    assert.deepEqual(await evaluation(tokenId), first);
  });

  test("the public evaluation never shows the private price levels", async () => {
    const tokenId = await publish();
    await prices([[-1, "3550"], [2, "3610"], [4, "3910"]]);
    afterDeadline();
    // The whole proof holds random hashes, so look for the levels in the evaluation and for the field names everywhere.
    const proof = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body;
    const ev = JSON.stringify(proof.evaluation);
    for (const level of ["3600", "3450", "3900"]) assert.ok(!ev.includes(level), level);
    const text = JSON.stringify(proof) + JSON.stringify((await api("GET", `/v1/tokens/${tokenId}/preview`)).body);
    for (const field of ["entry_price", "invalidation_price", "target_price"]) assert.ok(!text.includes(field), field);
  });
});

describe("closing a trade and its result", () => {
  async function buy(tokenId: string, quantity: string, price: string) {
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } });
    const order = await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "buy", quantity, authorise_fee: true },
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { price } });
    return order.body.id as string;
  }
  const close = (orderId: string, body: Record<string, unknown>) => api("POST", `/v1/sim/orders/${orderId}/close`, { body });

  test("an order with no fills has nothing to close, and a close cannot exceed the position", async () => {
    const tokenId = await publish();
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } });
    const order = (await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "buy", quantity: "1", authorise_fee: true },
    })).body;
    assert.equal((await close(order.id, { price: "3700" })).body.error.code, "nothing_to_close");

    const filled = await buy(tokenId, "1", "3600");
    assert.equal((await close(filled, { quantity: "2", price: "3700" })).body.error.code, "overclose");
    assert.equal((await close(filled, { quantity: "1" })).body.error.code, "close_needs_fill");
  });

  test("a partial close is recorded; the result comes when the whole position is closed", async () => {
    const tokenId = await publish();
    const orderId = await buy(tokenId, "2", "3600");
    const earned = (await api("GET", "/v1/ledger/balances/alice.testnet")).body.earned.near;

    const part = await close(orderId, { quantity: "1", price: "3780" });
    assert.equal(part.status, 201);
    assert.equal(part.body.event.effect, "position_closed");
    let trade = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade[0];
    assert.deepEqual({ ...trade.closing_fill, at: undefined }, { at: undefined, price: "3780", quantity: "1", complete: false, source: "simulated" });
    assert.equal(trade.result, null);

    await close(orderId, { price: "3780" }); // the rest
    trade = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade[0];
    assert.equal(trade.closing_fill.complete, true);
    assert.deepEqual({ ...trade.result, closed_at: undefined }, {
      closed_at: undefined, quantity: "2", entry_price: "3600", exit_price: "3780",
      entry_value_usd: 7200, net_profit_usd: 360, net_return_pct: 5,
    });
    // Closing pays nothing more.
    assert.equal((await api("GET", "/v1/ledger/balances/alice.testnet")).body.earned.near, earned);
  });

  test("verified results and the creator score: net return %, net profit $ and maximum drawdown %", async () => {
    const tokenId = await publish();
    // +5%, -3%, -4%, +10%: net +8%. The running total peaks at +5% and falls to -2%, a 7% drawdown.
    for (const exit of ["1050", "970", "960", "1100"]) await close(await buy(tokenId, "1", "1000"), { price: exit });

    const results = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.verified_results;
    assert.deepEqual({ ...results, costs: undefined }, {
      trades: 4, net_return_pct: 8, net_profit_usd: 80, max_drawdown_pct: 7, costs: undefined,
    });

    await prices([[-1, "3550"], [2, "3610"], [4, "3910"]]);
    afterDeadline();
    const score = (await api("GET", "/v1/publishers/alice.testnet")).body.score;
    assert.deepEqual({ ...score.borrowers, costs: undefined }, { ...results, costs: undefined });
    assert.deepEqual(score.accuracy, { evaluated: 1, met: 1, accuracy_pct: 100, pending: 0, not_judged: 0 });

    // A second thesis that is invalidated halves the accuracy; one still before its deadline is pending.
    mock.timers.setTime(T0);
    const wrong = await publish();
    const later = await publish({ expires_at: at(48) });
    await prices([[0.5, "3400"]]);
    afterDeadline();
    assert.equal((await evaluation(wrong)).outcome, "invalidated");
    assert.equal((await evaluation(later)).status, "pending");
    assert.deepEqual((await api("GET", "/v1/publishers/alice.testnet")).body.score.accuracy, {
      evaluated: 2, met: 1, accuracy_pct: 50, pending: 1, not_judged: 0,
    });
  });
});

// Found by local testing: each test reproduces one confirmed bug.
describe("regressions from local testing", () => {
  async function filledOrder(tokenId: string, price: string, side = "buy") {
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } });
    const order = (await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote.body.quote_id, side, quantity: "1", authorise_fee: true },
    })).body;
    assert.equal((await api("POST", `/v1/sim/orders/${order.id}/fill`, { body: { price } })).status, 201);
    return order.id as string;
  }

  test("a target or invalidation already passed at publish is not judged, and nothing is dated before publish", async () => {
    await prices([[-1, "3950"]]); // already past the 3900 target
    const pastTarget = await publish();
    mock.timers.setTime(T0 + 2 * 3_600_000);
    await prices([[1.5, "3400"]]); // already past the 3450 invalidation at the second publish
    const pastInvalidation = await publish({ expires_at: at(26) });
    mock.timers.setTime(T0 + 27 * 3_600_000);
    for (const tokenId of [pastTarget, pastInvalidation]) {
      const ev = await evaluation(tokenId);
      assert.equal(ev.outcome, "already_reached");
      assert.equal(ev.conditions_met, null);
      assert.equal(ev.target_hit_at, null);
      assert.equal(ev.invalidated_at, null);
    }
    const { accuracy } = (await api("GET", "/v1/publishers/alice.testnet")).body.score;
    assert.equal(accuracy.evaluated, 0);
  });

  test("without a target, the move is measured from where the thesis was entered, not from the entry level", async () => {
    // Long entered at publish (3550, above the 3000 entry), then the price falls: that is not a success.
    const tokenId = await publish({ entry_price: "3000", invalidation_price: undefined, target_price: undefined });
    await prices([[-1, "3550"], [2, "3300"], [3, "3100"]]);
    afterDeadline();
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "against_direction");
    assert.equal(ev.conditions_met, false);
    assert.equal(ev.entered_at, at(0));
  });

  test("market names are matched whatever their case", async () => {
    const tokenId = await publish({ market: "eth-usd" });
    assert.equal((await api("GET", `/v1/tokens/${tokenId}/preview`)).body.market, "ETH-USD");
    await prices([[-1, "3550"], [2, "3610"], [4, "3910"]], "Eth-Usd");
    afterDeadline();
    assert.equal((await evaluation(tokenId)).outcome, "target_hit");
    // Setup's own thesis expired before the mocked clock's start, so this is the only ETH-USD one.
    assert.deepEqual((await api("GET", "/v1/tokens?market=eth-usd")).body.tokens.map((t: { token_id: string }) => t.token_id), [tokenId]);
  });

  test("closing a position that is already closed says so", async () => {
    const orderId = await filledOrder(await publish(), "3600");
    assert.equal((await api("POST", `/v1/sim/orders/${orderId}/close`, { body: { price: "3700" } })).status, 201);
    const again = await api("POST", `/v1/sim/orders/${orderId}/close`, { body: { price: "3700" } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "nothing_to_close");
  });

  test("a fill at price 0 is refused, so it cannot wipe out the track record", async () => {
    const tokenId = await publish();
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } });
    const order = (await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "buy", quantity: "1", authorise_fee: true },
    })).body;
    const fill = await api("POST", `/v1/sim/orders/${order.id}/fill`, { body: { price: "0" } });
    assert.equal(fill.status, 400);
  });

  test("totals add up unrounded results and round once", async () => {
    const tokenId = await publish();
    // Each trade makes $0.004, which rounds to $0.00 on its own; three of them make $0.012, shown as $0.01.
    for (let i = 0; i < 3; i++) {
      await api("POST", `/v1/sim/orders/${await filledOrder(tokenId, "1000")}/close`, { body: { price: "1000.004" } });
    }
    const proof = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body;
    assert.deepEqual(proof.proofs_of_trade.map((t: { result: { net_profit_usd: number } }) => t.result.net_profit_usd), [0, 0, 0]);
    assert.equal(proof.verified_results.net_profit_usd, 0.01);
  });

  test("market prices can be dated with a time zone offset", async () => {
    const r = await api("POST", "/v1/sim/market/ETH-USD/prices", { body: { price: "3500", at: "2030-03-01T08:00:00+08:00" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.at, "2030-03-01T00:00:00.000Z");
  });
});
