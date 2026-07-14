// Tests for authentication on the money-moving endpoints.
//
// Before this, the payment API had no authentication whatsoever: the caller
// named an account in the request body and the server acted on it. Typing
// someone else's friendly ID into /userdet or /userbal read their name, address,
// date of birth and balance; typing it into /payment spent their money. CORS was
// `*`, so any website could do all of that from a visitor's browser.
//
// The assertions that matter here are the negative ones: that an unauthenticated
// request is refused, and -- most of all -- that a caller cannot act on an
// account it did not authenticate as, no matter what it puts in the body.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer, waitFor, settle, authHeader, TEST_SESSION_SECRET } = require("./helpers");
const fetchFake = require("./fakes/node-fetch");
const { makeFakeResponse } = require("./fakes/response");
const auth = require("../auth");

const PROTECTED = [
  { method: "post", path: "/userdet", body: {} },
  { method: "post", path: "/userbal", body: {} },
  { method: "post", path: "/payment", body: { receiver: "bob*bankb.com", amount: "100" } },
  { method: "get", path: "/bankuser", body: {} },
];

// ------------------------------------------------------------ the primitives

test("password hashing", async (t) => {
  await t.test("verifies a correct password and rejects a wrong one", () => {
    const stored = auth.hashPassword("correct horse battery staple");

    assert.equal(auth.verifyPassword("correct horse battery staple", stored), true);
    assert.equal(auth.verifyPassword("wrong password", stored), false);
    assert.equal(auth.verifyPassword("", stored), false);
  });

  await t.test("salts, so the same password hashes differently each time", () => {
    assert.notEqual(auth.hashPassword("same"), auth.hashPassword("same"));
  });

  await t.test("never authenticates against a missing or junk stored hash", () => {
    // A user row with no password set must not be loggable-in to.
    for (const stored of [null, undefined, "", "not-a-hash", "scrypt$$$$$", 12345, {}]) {
      assert.equal(auth.verifyPassword("anything", stored), false, `stored: ${stored}`);
    }
  });

  await t.test("takes as long to reject an account with no hash as one with", () => {
    // /login answers 401 in the same words whether the friendly ID exists or
    // not, precisely so that it can't be used to enumerate accounts. That was
    // undone by the clock: verifyPassword() used to return false *immediately*
    // when there was no stored hash to check against, and spend ~100ms of scrypt
    // when there was. The reply was identical; how long it took to arrive was
    // not, and that is just as good an answer to "does alice bank here?".
    const stored = auth.hashPassword("hunter2");

    function timeOf(work) {
      const start = process.hrtime.bigint();
      work();
      return Number(process.hrtime.bigint() - start);
    }

    // Warm up, so neither figure includes first-call overhead.
    auth.verifyPassword("wrong", stored);

    const real = timeOf(() => auth.verifyPassword("wrong", stored));
    const absent = timeOf(() => auth.verifyPassword("wrong", null));

    // A generous margin: the point is that rejecting an unknown account costs
    // real work, not that the two are identical to the nanosecond. Before the
    // fix `absent` was a few microseconds against `real`'s ~100ms, so any
    // fraction at all separates the two.
    assert.ok(
      absent > real / 2,
      `rejecting an unknown account took ${absent / 1e6}ms against ${real / 1e6}ms for a ` +
        `known one -- the difference is an enumeration oracle`
    );
  });
});

test("tokens", async (t) => {
  const secret = "a-secret-that-is-long-enough";

  await t.test("round-trips the account it was issued for", () => {
    const token = auth.issueToken("alice", secret);
    assert.equal(auth.verifyToken(token, secret).sub, "alice");
  });

  await t.test("rejects a token signed with a different secret", () => {
    const token = auth.issueToken("alice", "some-other-secret-entirely");
    assert.equal(auth.verifyToken(token, secret), null);
  });

  await t.test("rejects a token whose payload was edited", () => {
    // The whole point: a client must not be able to rewrite `sub` to another
    // account and have the server believe it.
    const token = auth.issueToken("alice", secret);
    const signature = token.split(".")[1];
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "bob", exp: 9999999999 }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    assert.equal(auth.verifyToken(forgedPayload + "." + signature, secret), null);
  });

  await t.test("rejects an expired token", () => {
    const issuedLongAgo = 1000;
    const token = auth.issueToken("alice", secret, issuedLongAgo);

    assert.ok(auth.verifyToken(token, secret, issuedLongAgo + 60), "still valid a minute later");
    assert.equal(
      auth.verifyToken(token, secret, issuedLongAgo + auth.TOKEN_TTL_SECONDS + 1),
      null,
      "must not still be valid past its expiry"
    );
  });

  await t.test("rejects malformed tokens instead of throwing", () => {
    for (const bad of [null, undefined, "", "garbage", "a.b.c", "....", 42, {}]) {
      assert.equal(auth.verifyToken(bad, secret), null, `token: ${JSON.stringify(bad)}`);
    }
  });
});

// ------------------------------------------------------------- the endpoints

for (const file of ["DBServerA.js", "DBServerB.js"]) {
  test(`${file} authentication`, async (t) => {
    const { client, app } = loadServer(file);

    // Note: does NOT reset the fakes -- a caller that queued responses must not
    // have them wiped out from under it. Reset explicitly before queueing.
    async function call(method, path, req) {
      const res = makeFakeResponse();
      app._getRoute(method, path)(req, res);
      await waitFor(() => res.endCount > 0 || res.lastJson !== undefined, { timeout: 500 }).catch(
        () => {
          throw new Error(`${path} never responded`);
        }
      );
      await settle();
      return res;
    }

    await t.test("every money/PII route refuses an unauthenticated request", async () => {
      for (const { method, path, body } of PROTECTED) {
        for (const [label, headers] of [
          ["no Authorization header", {}],
          ["empty bearer", { authorization: "Bearer " }],
          ["garbage token", { authorization: "Bearer garbage" }],
          ["not a bearer scheme", { authorization: "Basic YWxpY2U6cw==" }],
          [
            "token signed with the wrong secret",
            { authorization: "Bearer " + auth.issueToken("alice", "the-wrong-secret-entirely") },
          ],
        ]) {
          client.reset();
          fetchFake.reset();
          const res = await call(method, path, { headers, body });

          assert.equal(res.statusCode, 401, `${path} with ${label} must be 401`);
          assert.equal(client.queries.length, 0, `${path} with ${label} must not query the DB`);
          assert.equal(fetchFake.calls.length, 0, `${path} with ${label} must not pay anyone`);
        }
      }
    });

    await t.test("an expired token is refused", async () => {
      client.reset();
      const stale = auth.issueToken("alice", TEST_SESSION_SECRET, 1000);
      const res = await call("post", "/userbal", {
        headers: { authorization: "Bearer " + stale },
        body: {},
      });

      assert.equal(res.statusCode, 401);
    });

    // The core of the whole item: the body cannot name the account.
    await t.test("/payment spends the TOKEN's account, not the body's", async () => {
      client.reset();
      fetchFake.reset();
      client.queueResponse({ error: null, results: { rowCount: 1, rows: [] } }); // debit
      fetchFake.queueResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ hash: "abc" }),
      });

      const res = makeFakeResponse();
      app._getRoute("post", "/payment")(
        {
          headers: authHeader("alice"),
          // A caller trying to drain someone else's account the old way.
          body: { account: "victim*banka.com", receiver: "mallory*bankb.com", amount: "100" },
        },
        res
      );
      await waitFor(() => res.endCount > 0);

      const debit = client.queries[0];
      assert.deepEqual(
        debit.params,
        [100, "alice"],
        "the debit must hit the authenticated account, never the one named in the body"
      );
      assert.ok(
        !JSON.stringify(client.queries).includes("victim"),
        "the body's account must not reach the database at all"
      );
    });

    await t.test("/userdet and /userbal read the TOKEN's account, not the body's", async () => {
      for (const path of ["/userdet", "/userbal"]) {
        client.reset();
        client.queueResponse({
          error: null,
          results: { rowCount: 1, rows: [{ name: "Alice", balance: 10 }] },
        });

        const res = makeFakeResponse();
        app._getRoute("post", path)(
          { headers: authHeader("alice"), body: { friendlyid: "victim*banka.com" } },
          res
        );
        await waitFor(() => res.endCount > 0 || res.lastJson !== undefined);

        assert.deepEqual(
          client.queries[0].params,
          ["alice"],
          `${path} must look up the authenticated account, not the one in the body`
        );
      }
    });

    // ------------------------------------------------------------- /login

    await t.test("/login issues a token for correct credentials", async () => {
      const stored = auth.hashPassword("hunter2");
      client.reset();
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: stored }] },
      });

      const res = await call("post", "/login", {
        headers: {},
        body: { friendlyid: "alice*banka.com", password: "hunter2" },
      });

      assert.equal(res.lastJson.msg, "SUCCESS!");
      assert.equal(
        auth.verifyToken(res.lastJson.token, TEST_SESSION_SECRET).sub,
        "alice",
        "the token must be issued for the account that logged in"
      );
    });

    await t.test("/login rejects a wrong password", async () => {
      const stored = auth.hashPassword("hunter2");
      client.reset();
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: stored }] },
      });

      const res = await call("post", "/login", {
        headers: {},
        body: { friendlyid: "alice", password: "not-hunter2" },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.lastJson.token, undefined, "no token may be handed out");
    });

    await t.test("/login rejects an unknown account with the same answer", async () => {
      client.reset();
      client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } });

      const res = await call("post", "/login", {
        headers: {},
        body: { friendlyid: "nobody", password: "whatever" },
      });

      // Identical to the wrong-password response, so /login can't be used to
      // enumerate which friendly IDs exist.
      assert.equal(res.statusCode, 401);
      assert.equal(res.lastJson.error_msg, "Invalid credentials");
    });

    await t.test("/login rejects a user with no password set", async () => {
      client.reset();
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: null }] },
      });

      const res = await call("post", "/login", {
        headers: {},
        body: { friendlyid: "alice", password: "anything" },
      });

      assert.equal(res.statusCode, 401, "a NULL password_hash must not authenticate anyone");
    });

    // --------------------------------------------------------------- CORS

    await t.test("CORS is an allow-list, not a wildcard", async () => {
      // Located by behavior rather than by index: body-parser is registered
      // ahead of it, and that ordering isn't what this test is about.
      const cors = app._getMiddleware().find((fn) => {
        const probe = makeFakeResponse();
        fn({ headers: { origin: "http://localhost:3000" } }, probe, () => {});
        return probe.headers["Vary"] === "Origin";
      });
      assert.ok(cors, "the server must register a CORS middleware");

      const evil = makeFakeResponse();
      cors({ headers: { origin: "https://evil.example" } }, evil, () => {});
      assert.equal(
        evil.headers["Access-Control-Allow-Origin"],
        undefined,
        "an unknown origin must not be granted access"
      );

      const good = makeFakeResponse();
      cors({ headers: { origin: "http://localhost:3000" } }, good, () => {});
      assert.equal(good.headers["Access-Control-Allow-Origin"], "http://localhost:3000");
      assert.equal(good.headers["Vary"], "Origin");
    });
  });
}
