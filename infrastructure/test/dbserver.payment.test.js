// Offline regression tests for the /payment route in DBServerA.js and
// DBServerB.js.
//
// These exercise the real route handler functions from the committed
// source files (not a re-implementation), using hand-written in-memory
// fakes for `pg`, `express`, `body-parser` and `request` (see ./fakes and
// ./mockRequire.js). No real Postgres, HTTP server, or network call is
// involved, and no real npm packages need to be installed.
//
// Run with:  node --test infrastructure/test
//
// Background: the original /payment handler was missing `return`
// statements after it sent an error response for (a) a DB error and
// (b) insufficient balance. Because of that, execution fell through and
// the handler went on to build a payment request and POST it to the
// bridge server anyway, then tried to end the same HTTP response a
// second time. These tests pin down the fixed behavior: on error or
// insufficient balance, the handler must respond exactly once and must
// never call out to the bridge server.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { installMockRequire } = require("./mockRequire");
installMockRequire();

const express = require("./fakes/express");
const { Client } = require("./fakes/pg");
const requestFake = require("./fakes/request");
const { makeFakeResponse } = require("./fakes/response");

function waitFor(predicate, { timeout = 1000, interval = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error("waitFor: timed out waiting for condition"));
      }
      setTimeout(check, interval);
    })();
  });
}

// Loads one of the server files fresh and returns the fake `app` and
// `client` instances it created, so a test can reach into its route
// handlers and control what the "database" returns.
function loadServer(fileName) {
  const modulePath = path.join(__dirname, "..", fileName);
  const clientCountBefore = Client.instances.length;
  const appCountBefore = express.instances.length;

  delete require.cache[require.resolve(modulePath)];
  require(modulePath);

  const client = Client.instances[clientCountBefore];
  const app = express.instances[appCountBefore];
  return { client, app };
}

test("DBServerA /payment", async (t) => {
  const { client, app } = loadServer("DBServerA.js");
  const handler = app._getRoute("post", "/payment");
  assert.ok(typeof handler === "function", "/payment route must be registered");

  await t.test("insufficient balance: responds once, never calls the bridge", async () => {
    client.reset();
    requestFake.reset();
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ balance: 10 }] },
    });

    const req = {
      body: { account: "alice*banka.com", amount: "500", receiver: "bob*bankb.com" },
    };
    const res = makeFakeResponse();

    handler(req, res);
    await waitFor(() => res.endCount > 0);
    // give any accidental extra async work a chance to run before asserting
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requestFake.calls.length, 0, "bridge server must not be called when balance is insufficient");
    assert.equal(res.endCount, 1, "response must be ended exactly once");
    assert.equal(res.lastJson.msg, "ERROR!");
    assert.equal(res.lastJson.error_msg, "Insufficient balance!");
  });

  await t.test("DB error looking up balance: responds once, never calls the bridge", async () => {
    client.reset();
    requestFake.reset();
    client.queueResponse({ error: new Error("connection lost"), results: null });

    const req = {
      body: { account: "alice*banka.com", amount: "500", receiver: "bob*bankb.com" },
    };
    const res = makeFakeResponse();

    handler(req, res);
    await waitFor(() => res.endCount > 0);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requestFake.calls.length, 0, "bridge server must not be called on a DB error");
    assert.equal(res.endCount, 1, "response must be ended exactly once");
    assert.equal(res.lastJson.msg, "ERROR!");
  });

  await t.test("sufficient balance: calls the bridge and reports success", async () => {
    client.reset();
    requestFake.reset();
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ balance: 5000 }] },
    });
    requestFake.queueResponse({
      err: null,
      res: { statusCode: 200 },
      body: JSON.stringify({ hash: "abc123" }),
    });
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ balance: 5000 }] },
    });
    client.queueResponse({ error: null, results: { rowCount: 1, rows: [{}] } });

    const req = {
      body: { account: "alice*banka.com", amount: "100", receiver: "bob*bankb.com" },
    };
    const res = makeFakeResponse();

    handler(req, res);
    await waitFor(() => res.endCount > 0);

    assert.equal(requestFake.calls.length, 1, "bridge server must be called exactly once");
    assert.equal(requestFake.calls[0].form.amount, "100");
    assert.equal(requestFake.calls[0].form.destination, "bob*bankb.com");
    assert.equal(res.lastJson.msg, "SUCCESS!");
    assert.equal(res.endCount, 1, "response must be ended exactly once");
  });
});

test("DBServerB /payment (same fix, mirrored file)", async (t) => {
  const { client, app } = loadServer("DBServerB.js");
  const handler = app._getRoute("post", "/payment");
  assert.ok(typeof handler === "function", "/payment route must be registered");

  await t.test("insufficient balance: responds once, never calls the bridge", async () => {
    client.reset();
    requestFake.reset();
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ balance: 5 }] },
    });

    const req = {
      body: { account: "carol*bankb.com", amount: "999", receiver: "dave*banka.com" },
    };
    const res = makeFakeResponse();

    handler(req, res);
    await waitFor(() => res.endCount > 0);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requestFake.calls.length, 0, "bridge server must not be called when balance is insufficient");
    assert.equal(res.endCount, 1, "response must be ended exactly once");
    assert.equal(res.lastJson.error_msg, "Insufficient balance!");
  });
});
