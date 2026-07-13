// Offline tests for /receive in CallbacksA.js / CallbacksB.js -- the endpoint
// the bridge calls to credit an incoming payment.
//
// Three bugs are pinned here:
//   1. No idempotency check, despite a code comment asking for one. A retried
//      webhook credited the balance a second time.
//   2. The credited amount was parseInt()'d, dropping the cents.
//   3. The credit was a read-then-write (SELECT balance, then UPDATE balance =
//      <that value> + amount), so a concurrent credit or debit was silently
//      lost.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer, waitFor, settle } = require("./helpers");
const { makeFakeResponse } = require("./fakes/response");

const TX_ID = "tx-4242";

function receiveRequest(overrides = {}) {
  return {
    body: Object.assign(
      {
        transaction_id: TX_ID,
        route: "bob",
        amount: "12.75",
        asset_code: "USD",
        data: JSON.stringify({
          sender: "alice*banka.com",
          attachment: JSON.stringify({
            transaction: { sender_info: { name: "Alice" } },
          }),
        }),
      },
      overrides
    ),
  };
}

// The programmed results for a first-time delivery, in the order the handler
// issues them: BEGIN, SELECT ... FOR UPDATE, duplicate check, INSERT, UPDATE,
// COMMIT.
function queueFirstDelivery(client, { accountExists = true, alreadySeen = false } = {}) {
  client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // BEGIN
  client.queueResponse({
    error: null,
    results: accountExists
      ? { rowCount: 1, rows: [{ friendlyid: "bob" }] }
      : { rowCount: 0, rows: [] },
  }); // SELECT ... FOR UPDATE
  if (!accountExists) return;
  client.queueResponse({
    error: null,
    results: alreadySeen ? { rowCount: 1, rows: [{ "?column?": 1 }] } : { rowCount: 0, rows: [] },
  }); // duplicate check
  if (alreadySeen) return;
  client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // INSERT
  client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // UPDATE
  client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // COMMIT
}

function findQuery(client, fragment) {
  return client.queries.find((q) => q.sql.includes(fragment));
}

for (const file of ["CallbacksA.js", "CallbacksB.js"]) {
  test(`${file} /receive`, async (t) => {
    const { client, app } = loadServer(file);
    const handler = app._getRoute("post", "/receive");
    assert.ok(typeof handler === "function", "/receive must be registered");

    await t.test("credits the exact amount, cents included", async () => {
      client.reset();
      queueFirstDelivery(client);

      const res = makeFakeResponse();
      handler(receiveRequest({ amount: "12.75" }), res);
      await waitFor(() => res.endCount > 0);

      assert.equal(res.statusCode, 200);

      const credit = findQuery(client, "UPDATE users");
      assert.ok(credit, "the balance must be updated");
      assert.equal(
        credit.params[0],
        12.75,
        "the receiver must be credited the full amount, not a truncated $12"
      );

      const insert = findQuery(client, "INSERT INTO transactions");
      assert.equal(insert.params[3], 12.75, "the recorded amount must match the credit");
    });

    await t.test("credits by delegating the arithmetic to the DB, not read-then-write", async () => {
      client.reset();
      queueFirstDelivery(client);

      const res = makeFakeResponse();
      handler(receiveRequest(), res);
      await waitFor(() => res.endCount > 0);

      const credit = findQuery(client, "UPDATE users");
      assert.match(
        credit.sql,
        /balance\s*=\s*balance\s*\+/,
        "the credit must be computed by Postgres (balance = balance + $1), so a " +
          "concurrent update can't be lost"
      );
      assert.ok(
        !findQuery(client, "SELECT balance FROM users"),
        "must not read the balance and write it back -- that's the lost-update race"
      );
    });

    await t.test("takes a row lock and runs as one transaction", async () => {
      client.reset();
      queueFirstDelivery(client);

      const res = makeFakeResponse();
      handler(receiveRequest(), res);
      await waitFor(() => res.endCount > 0);

      const sql = client.sqlLog();
      assert.equal(sql[0], "BEGIN");
      assert.match(sql[1], /FOR UPDATE/, "the receiving account row must be locked");
      assert.equal(sql[sql.length - 1], "COMMIT");
      assert.equal(client.released, client.borrowed, "the connection must be released");
    });

    await t.test("DUPLICATE delivery does not credit a second time", async () => {
      client.reset();
      queueFirstDelivery(client, { alreadySeen: true });

      const res = makeFakeResponse();
      handler(receiveRequest(), res);
      await waitFor(() => res.endCount > 0);
      await settle();

      assert.equal(res.statusCode, 200, "a retry of a handled payment is a success, not an error");
      assert.ok(
        !findQuery(client, "UPDATE users"),
        "a duplicate delivery must NOT touch the balance"
      );
      assert.ok(
        !findQuery(client, "INSERT INTO transactions"),
        "a duplicate delivery must NOT record the transaction again"
      );
      assert.ok(client.sqlLog().includes("ROLLBACK"));
      assert.equal(client.released, client.borrowed, "the connection must be released");
    });

    await t.test("a concurrent duplicate (unique violation) is not double-credited", async () => {
      client.reset();
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // BEGIN
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "bob" }] },
      }); // FOR UPDATE
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // dup check: not seen
      const uniqueViolation = new Error("duplicate key value violates unique constraint");
      uniqueViolation.code = "23505";
      client.queueResponse({ error: uniqueViolation, results: null }); // INSERT loses the race

      const res = makeFakeResponse();
      handler(receiveRequest(), res);
      await waitFor(() => res.endCount > 0);
      await settle();

      assert.equal(res.statusCode, 200, "the payment is credited exactly once -- that's a success");
      assert.ok(!findQuery(client, "UPDATE users"), "must not credit after losing the race");
      assert.ok(client.sqlLog().includes("ROLLBACK"));
      assert.equal(client.released, client.borrowed, "the connection must be released");
    });

    await t.test("rolls back and 404s an unknown receiver", async () => {
      client.reset();
      queueFirstDelivery(client, { accountExists: false });

      const res = makeFakeResponse();
      handler(receiveRequest({ route: "nobody" }), res);
      await waitFor(() => res.endCount > 0);
      await settle();

      assert.equal(res.statusCode, 404);
      assert.ok(
        !findQuery(client, "INSERT INTO transactions"),
        "must not record a transaction it can't credit"
      );
      assert.ok(client.sqlLog().includes("ROLLBACK"));
      assert.equal(client.released, client.borrowed, "the connection must be released");
    });

    await t.test("rolls back and 500s if the credit fails", async () => {
      client.reset();
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // BEGIN
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "bob" }] },
      }); // FOR UPDATE
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } }); // dup check
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // INSERT
      client.queueResponse({ error: new Error("disk full"), results: null }); // UPDATE fails

      const res = makeFakeResponse();
      handler(receiveRequest(), res);
      await waitFor(() => res.endCount > 0);
      await settle();

      assert.equal(res.statusCode, 500);
      assert.ok(
        client.sqlLog().includes("ROLLBACK"),
        "the recorded transaction must be rolled back with the failed credit"
      );
      assert.ok(!client.sqlLog().includes("COMMIT"));
      assert.equal(client.released, client.borrowed, "the connection must be released");
    });

    await t.test("rejects bad input before opening a transaction", async () => {
      for (const [label, overrides] of [
        ["negative amount", { amount: "-100" }],
        ["non-numeric amount", { amount: "abc" }],
        ["zero amount", { amount: "0" }],
        ["missing amount", { amount: undefined }],
        ["missing route", { route: undefined }],
        ["missing transaction_id", { transaction_id: undefined }],
        ["malformed data payload", { data: "not json" }],
      ]) {
        client.reset();

        const res = makeFakeResponse();
        handler(receiveRequest(overrides), res);
        await waitFor(() => res.endCount > 0);
        await settle();

        assert.equal(res.statusCode, 400, `${label} must be rejected`);
        assert.equal(client.queries.length, 0, `${label} must not reach the database`);
      }
    });
  });
}
