// Offline tests for the /payment route in DBServerA.js and DBServerB.js.
//
// These exercise the real route handlers from the committed source files (not a
// re-implementation), using hand-written in-memory fakes for `pg`, `express`,
// `body-parser` and `node-fetch` (see ./fakes and ./mockRequire.js). No real
// Postgres, HTTP server, or network call is involved.
//
// The same suite runs against both files. They are near-identical copies of each
// other, and every bug found in this endpoint so far has been present in both,
// so testing one and eyeballing the other is how a fix ends up half-applied.
//
// Bugs pinned here:
//   - Missing `return` after the insufficient-balance / DB-error responses, so
//     the handler paid out anyway (fixed in the previous hardening pass).
//   - No validation of `amount`: a negative amount passed the balance check and
//     *increased* the sender's balance; a non-numeric one wrote NaN.
//   - Missing fields and unknown accounts produced no HTTP response at all --
//     the caller hung until its own timeout.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer, waitFor, settle, authHeader, audienceFor } = require("./helpers");
const fetchFake = require("./fakes/node-fetch");
const { makeFakeResponse } = require("./fakes/response");

const SERVERS = [
  { file: "DBServerA.js", account: "alice*banka.com", receiver: "bob*bankb.com" },
  { file: "DBServerB.js", account: "carol*bankb.com", receiver: "dave*banka.com" },
];

for (const { file, account, receiver } of SERVERS) {
  test(`${file} /payment`, async (t) => {
    const { client, app } = loadServer(file);
    const handler = app._getRoute("post", "/payment");
    assert.ok(typeof handler === "function", "/payment route must be registered");

    const senderId = account.split("*")[0];

    // /payment takes the sender from the verified token, so a request needs an
    // Authorization header rather than an `account` body field.
    function paymentRequest(overrides = {}) {
      const { headers, ...body } = overrides;
      return {
        headers: headers === undefined ? authHeader(senderId, audienceFor(file)) : headers,
        body: Object.assign({ receiver, amount: "100" }, body),
      };
    }

    // Clears recorded queries/bridge calls and any unconsumed programmed
    // results. Call before queueing a case's responses, not after.
    function fresh() {
      client.reset();
      fetchFake.reset();
    }

    // Drives the handler and waits for it to answer. Fails loudly (rather than
    // hanging the test run) if it never does -- which is the bug for several of
    // the cases below.
    async function call(req) {
      const res = makeFakeResponse();
      handler(req, res);
      await waitFor(() => res.endCount > 0 || res.lastJson !== undefined, {
        timeout: 500,
      }).catch(() => {
        throw new Error("handler never sent a response (the caller would hang)");
      });
      // Let any accidental extra async work run, so a handler that wrongly keeps
      // going after responding is caught.
      await settle();
      return res;
    }

    await t.test("insufficient balance: responds once, never calls the bridge", async () => {
      fresh();
      // The conditional debit matches no row (balance >= 500 is false)...
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } });
      // ...and the follow-up lookup shows the account exists, just short.
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [{ balance: 10 }] } });

      const res = await call(paymentRequest({ amount: "500" }));

      assert.equal(fetchFake.calls.length, 0, "must not call the bridge when funds are short");
      assert.equal(res.lastJson.error_msg, "Insufficient balance!");
    });

    await t.test("DB error looking up balance: responds once, never calls the bridge", async () => {
      fresh();
      client.queueResponse({ error: new Error("connection lost"), results: null });

      const res = await call(paymentRequest());

      assert.equal(fetchFake.calls.length, 0, "must not call the bridge on a DB error");
      assert.equal(res.lastJson.msg, "ERROR!");
    });

    await t.test("unknown account: 404s instead of hanging", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // debit matches nothing
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // no such account

      const res = await call({
        headers: authHeader("nobody", audienceFor(file)),
        body: { receiver, amount: "100" },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(fetchFake.calls.length, 0);
    });

    await t.test("missing fields: 400s instead of hanging", async () => {
      for (const [label, overrides] of [
        ["missing receiver", { receiver: undefined }],
        ["missing amount", { amount: undefined }],
      ]) {
        fresh();
        const res = await call(paymentRequest(overrides));

        assert.equal(res.statusCode, 400, `${label} must be a 400`);
        assert.equal(client.queries.length, 0, `${label} must not reach the database`);
        assert.equal(fetchFake.calls.length, 0, `${label} must not reach the bridge`);
      }
    });

    await t.test("NEGATIVE amount is rejected (it used to credit the sender)", async () => {
      // The old code: `balance < Number("-100")` is false, so the balance check
      // passed; the debit was `balance + -amount`, i.e. balance - (-100), which
      // *added* 100 to the sender's balance. A negative transfer was free money.
      for (const amount of ["-100", "-0.01", -100]) {
        fresh();
        const res = await call(paymentRequest({ amount }));

        assert.equal(res.statusCode, 400, `amount ${amount} must be rejected`);
        assert.equal(client.queries.length, 0, "must not touch the balance");
        assert.equal(fetchFake.calls.length, 0, "must not call the bridge");
      }
    });

    await t.test("NON-NUMERIC amount is rejected (it used to write NaN)", async () => {
      for (const amount of ["abc", "", "  ", {}, true, "1e", "0", "0.00"]) {
        fresh();
        const res = await call(paymentRequest({ amount }));

        assert.equal(res.statusCode, 400, `amount ${JSON.stringify(amount)} must be rejected`);
        assert.equal(client.queries.length, 0, "must not touch the balance");
        assert.equal(fetchFake.calls.length, 0, "must not call the bridge");
      }
    });

    await t.test("sufficient balance: calls the bridge and reports success", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // funds reserved
      fetchFake.queueResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ hash: "abc123" }),
      });

      const res = await call(paymentRequest({ amount: "100" }));

      assert.equal(fetchFake.calls.length, 1, "bridge must be called exactly once");
      assert.equal(Number(fetchFake.formOf(0).amount), 100);
      assert.equal(fetchFake.formOf(0).destination, receiver);
      assert.equal(res.lastJson.msg, "SUCCESS!");
    });

    await t.test("a fractional amount reaches the bridge intact", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // funds reserved
      fetchFake.queueResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ hash: "abc123" }),
      });

      await call(paymentRequest({ amount: "12.75" }));

      assert.equal(
        Number(fetchFake.formOf(0).amount),
        12.75,
        "the cents must survive the sending side too"
      );
    });

    await t.test("debits with one conditional statement, not a read-then-write", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } });
      fetchFake.queueResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ hash: "abc123" }),
      });

      await call(paymentRequest({ amount: "100" }));

      const debit = client.queries[0];
      assert.match(
        debit.sql,
        /UPDATE users SET balance = balance - \$1 WHERE friendlyid = \$2 AND balance >= \$1/,
        "the balance check and the debit must be a single statement, so two " +
          "concurrent payments can't both pass the check against the same balance"
      );
      assert.deepEqual(debit.params, [100, senderId]);
    });

    await t.test("reserves the funds BEFORE calling the bridge", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } });
      fetchFake.queueResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ hash: "abc123" }),
      });

      await call(paymentRequest({ amount: "100" }));

      // Nothing may be sent to the bridge until the money is provably set
      // aside; otherwise the gap between "checked" and "debited" is a window
      // for a second payment to spend the same balance.
      assert.match(client.queries[0].sql, /UPDATE users SET balance = balance -/);
      assert.equal(fetchFake.calls.length, 1);
    });

    await t.test("refunds the reservation when the bridge fails", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // debit applied
      fetchFake.queueRejection(new Error("bridge unreachable"));
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // refund

      const res = await call(paymentRequest({ amount: "100" }));

      const refund = client.queries[client.queries.length - 1];
      assert.match(
        refund.sql,
        /UPDATE users SET balance = balance \+ \$1 WHERE friendlyid = \$2/,
        "a payment that never left must not stay debited"
      );
      assert.deepEqual(refund.params, [100, senderId]);
      assert.equal(res.lastJson.msg, "ERROR!");
    });

    await t.test("refunds the reservation when the bridge rejects the payment", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // debit applied
      fetchFake.queueResponse({ ok: false, status: 500, text: "bridge said no" });
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // refund

      const res = await call(paymentRequest({ amount: "100" }));

      assert.match(
        client.queries[client.queries.length - 1].sql,
        /UPDATE users SET balance = balance \+ \$1/,
        "a non-200 from the bridge means the money never left"
      );
      assert.equal(res.lastJson.msg, "ERROR!");
    });

    // A sent payment must never be refunded. The bridge call is a promise now,
    // and `.then(onSent).catch(onFailed)` would route anything the success path
    // threw into the refund handler -- refunding a payment the bridge had
    // already accepted, which creates money. The handler uses
    // `.then(onSent, onNotSent)` precisely so the refund path can only be
    // reached by a failed call to the bridge.
    await t.test("does NOT refund when the bridge accepted but answering threw", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // funds reserved
      fetchFake.queueResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ hash: "abc123" }),
      });

      // The payment goes through, and then answering the caller blows up.
      const res = makeFakeResponse();
      res.json = () => {
        throw new Error("socket closed while writing the response");
      };
      handler(paymentRequest({ amount: "100" }), res);

      // Let every pending continuation run, so a refund would have been issued
      // by now if one were going to be.
      await settle();
      await settle();

      const refunds = client
        .sqlLog()
        .filter((sql) => /balance = balance \+/.test(sql));
      assert.deepEqual(
        refunds,
        [],
        "the bridge accepted this payment -- refunding it would create money"
      );
    });

    await t.test("still responds if the refund itself fails", async () => {
      fresh();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // debit applied
      fetchFake.queueRejection(new Error("bridge unreachable"));
      client.queueResponse({ error: new Error("db gone"), results: null }); // refund fails

      const res = await call(paymentRequest({ amount: "100" }));

      assert.equal(res.lastJson.msg, "ERROR!", "the caller must still get an answer");
    });
  });
}
