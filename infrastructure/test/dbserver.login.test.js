// Offline tests for the rate limiting / lockout on POST /login.
//
// /login used to have neither. The route is careful in every other respect --
// the 401 is identical whether the account is unknown, has no password set, or
// the password is wrong, and the password hashing is deliberately slow -- but
// none of that costs an attacker anything if they may simply keep trying. A
// password list against one known friendly ID, or one common password sprayed
// across every friendly ID in turn, both ran at whatever rate the server would
// answer, and so did timing the route to learn which friendly IDs are real.
//
// So the assertions that matter here are: a run of failures stops being
// answered; a locked-out caller costs the server nothing (no database
// round-trip, no scrypt); nothing but a failed *password attempt* counts
// towards a lockout; and a lockout is not itself an enumeration oracle -- an
// invented friendly ID locks out exactly like a real one.
//
// Every failed login below really does run scrypt (~100ms), because that is the
// production path -- hence the low limits configured for the cases that only
// need to prove the counting, and the shipped limit of 5 only where it needs to
// be shown wired up.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer, loadDbServerWith, waitFor, settle } = require("./helpers");
const { makeFakeResponse } = require("./fakes/response");
const auth = require("../auth");

// One real hash, reused: making one costs the same ~100ms as checking one.
const PASSWORD = "hunter2";
const STORED = auth.hashPassword(PASSWORD);

// ------------------------------------------------------------- the primitive

test("login throttle", async (t) => {
  // A clock the test controls, so none of this waits on real time.
  const settings = { maxFailures: 3, windowSeconds: 100, lockoutSeconds: 60 };

  await t.test("locks a key out once the failures run out", () => {
    const throttle = auth.createLoginThrottle(settings);

    assert.equal(throttle.retryAfter("alice", 0), 0, "a key with no history may try");
    throttle.recordFailure("alice", 0);
    throttle.recordFailure("alice", 1);
    assert.equal(throttle.retryAfter("alice", 2), 0, "still inside the budget");

    throttle.recordFailure("alice", 2);
    assert.equal(throttle.retryAfter("alice", 2), 60, "the third failure locks it out");
  });

  await t.test("the lockout expires", () => {
    const throttle = auth.createLoginThrottle(settings);
    for (const at of [0, 1, 2]) throttle.recordFailure("alice", at);

    // The cooldown runs from the failure that tripped it (t=2), so it is up at
    // t=62 -- and the countdown handed to the caller says exactly that.
    assert.equal(throttle.retryAfter("alice", 61), 1, "one second still to go");
    assert.equal(throttle.retryAfter("alice", 62), 0, "may try again after the cooldown");
    assert.equal(
      throttle._size(),
      0,
      "the lapsed entry is dropped, not left behind to lock the key forever"
    );
  });

  await t.test("hammering a locked key keeps it locked", () => {
    // Otherwise an attacker just keeps firing and rides the original cooldown
    // out while still being counted.
    const throttle = auth.createLoginThrottle(settings);
    for (const at of [0, 1, 2]) throttle.recordFailure("alice", at);

    throttle.recordFailure("alice", 50);
    assert.equal(throttle.retryAfter("alice", 50), 60, "the cooldown restarts from the last try");
  });

  await t.test("knowing the password clears the failures", () => {
    // A typo, then the right password, must leave nothing behind.
    const throttle = auth.createLoginThrottle(settings);
    throttle.recordFailure("alice", 0);
    throttle.recordFailure("alice", 1);
    throttle.recordSuccess("alice");

    for (const at of [2, 3]) throttle.recordFailure("alice", at);
    assert.equal(throttle.retryAfter("alice", 3), 0, "the count started again from zero");
  });

  await t.test("failures spread thinly are forgotten, not accumulated", () => {
    // The budget is a rolling window, not a lifetime total: an account used for
    // years must not eventually lock out on its third-ever typo.
    const throttle = auth.createLoginThrottle(settings);
    throttle.recordFailure("alice", 0);
    throttle.recordFailure("alice", 50);
    throttle.recordFailure("alice", 500); // window has long since lapsed

    assert.equal(throttle.retryAfter("alice", 500), 0);
  });

  await t.test("keys don't interfere with each other", () => {
    const throttle = auth.createLoginThrottle(settings);
    for (const at of [0, 1, 2]) throttle.recordFailure("alice", at);

    assert.equal(throttle.retryAfter("alice", 2), 60);
    assert.equal(throttle.retryAfter("bob", 2), 0, "bob is locked out of nothing");
  });

  await t.test("the table stays bounded", () => {
    // The keys are attacker-supplied (whatever friendly ID they typed), so an
    // unbounded map is a memory leak anyone on the internet can drive.
    const throttle = auth.createLoginThrottle({ ...settings, maxTrackedKeys: 10 });
    for (let i = 0; i < 500; i++) throttle.recordFailure("made-up-id-" + i, 0);

    assert.ok(throttle._size() <= 10, `tracked ${throttle._size()} keys, cap is 10`);
  });
});

// ---------------------------------------------------------------- the route

// Drives a route handler and waits for it to answer, failing the test rather
// than hanging the run if it never does.
async function call(app, method, path, req) {
  const res = makeFakeResponse();
  app._getRoute(method, path)(req, res);
  await waitFor(() => res.endCount > 0 || res.lastJson !== undefined, { timeout: 2000 }).catch(
    () => {
      throw new Error(`${path} never responded`);
    }
  );
  await settle();
  return res;
}

function loginRequest(friendlyid, password, source) {
  return {
    headers: {},
    socket: { remoteAddress: source || "10.0.0.1" },
    body: { friendlyid, password },
  };
}

// The shipped limits (5 failures per account), against the real bank files.
for (const file of ["DBServerA.js", "DBServerB.js"]) {
  test(`${file} /login lockout`, async (t) => {
    const { client, app } = loadServer(file);

    await t.test("a run of wrong passwords stops being answered", async () => {
      client.reset();

      // Five attempts, each finding a real account and a wrong password.
      for (let attempt = 1; attempt <= auth.LOGIN_MAX_FAILURES; attempt++) {
        client.queueResponse({
          error: null,
          results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: STORED }] },
        });

        const res = await call(app, "post", "/login", loginRequest("alice", "guess-" + attempt));
        assert.equal(res.statusCode, 401, `attempt ${attempt} should be a plain rejection`);
      }

      // The sixth isn't answered on its merits at all.
      client.reset();
      const locked = await call(app, "post", "/login", loginRequest("alice", PASSWORD));

      assert.equal(locked.statusCode, 429, "the account must be locked out");
      assert.ok(
        Number(locked.headers["Retry-After"]) > 0,
        "and told when it may try again, not just refused"
      );
      assert.equal(
        locked.lastJson.token,
        undefined,
        "no token, even though that was the CORRECT password -- a locked account is locked"
      );
      assert.equal(
        client.queries.length,
        0,
        "a locked-out attempt must not even reach the database: refusing it has to be " +
          "cheaper for the server than making it, or the lockout is itself a way to load us"
      );
    });

    await t.test("an incomplete request is not a failed attempt", async () => {
      // Otherwise anyone could lock any account out of its own bank by posting
      // its friendly ID with no password five times.
      const { client: client2, app: app2 } = loadServer(file);
      client2.reset();

      for (let i = 0; i < 10; i++) {
        const res = await call(app2, "post", "/login", loginRequest("alice", ""));
        assert.equal(res.statusCode, 400);
      }

      client2.reset();
      client2.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: STORED }] },
      });
      const res = await call(app2, "post", "/login", loginRequest("alice", PASSWORD));

      assert.equal(res.lastJson.msg, "SUCCESS!", "alice must still be able to log in");
    });
  });
}

// The counting rules, on a server configured with a small budget so that each
// case costs a handful of scrypt runs rather than a dozen. Same handler.
test("/login lockout accounting", async (t) => {
  await t.test("a correct password clears the failures behind it", async () => {
    const { client, app } = loadDbServerWith({ loginFailuresPerAccount: 3 });

    for (let i = 0; i < 2; i++) {
      client.reset();
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: STORED }] },
      });
      const res = await call(app, "post", "/login", loginRequest("alice", "typo"));
      assert.equal(res.statusCode, 401);
    }

    client.reset();
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: STORED }] },
    });
    const ok = await call(app, "post", "/login", loginRequest("alice", PASSWORD));
    assert.equal(ok.lastJson.msg, "SUCCESS!");

    // Two more typos would be the 4th and 5th failure of the day if the
    // successful login hadn't cleared the slate; the budget is 3.
    for (let i = 0; i < 2; i++) {
      client.reset();
      client.queueResponse({
        error: null,
        results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: STORED }] },
      });
      const res = await call(app, "post", "/login", loginRequest("alice", "typo"));
      assert.equal(res.statusCode, 401, "a typo after a good login must not be a lockout");
    }
  });

  await t.test("a database error is not the caller's failed attempt", async () => {
    // A wobbly database must not lock every customer out of their money.
    const { client, app } = loadDbServerWith({ loginFailuresPerAccount: 2 });

    for (let i = 0; i < 5; i++) {
      client.reset();
      client.queueResponse({ error: new Error("connection terminated"), results: undefined });
      const res = await call(app, "post", "/login", loginRequest("alice", PASSWORD));
      assert.equal(res.statusCode, 500);
    }

    client.reset();
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ friendlyid: "alice", password_hash: STORED }] },
    });
    const res = await call(app, "post", "/login", loginRequest("alice", PASSWORD));
    assert.equal(res.lastJson.msg, "SUCCESS!", "alice logs in once the database is back");
  });

  await t.test("an invented friendly ID locks out just like a real one", async () => {
    // If only real accounts could be locked out, the lockout would answer the
    // very question the identical 401 bodies exist to refuse: which friendly
    // IDs are real?
    const { client, app } = loadDbServerWith({ loginFailuresPerAccount: 2 });
    client.reset();

    // rowCount 0 -- no such user. (The fake pg returns exactly this when nothing
    // is queued.)
    for (let i = 0; i < 2; i++) {
      const res = await call(app, "post", "/login", loginRequest("no-such-person", "guess"));
      assert.equal(res.statusCode, 401);
    }

    const locked = await call(app, "post", "/login", loginRequest("no-such-person", "guess"));
    assert.equal(locked.statusCode, 429, "a made-up account must lock out too");
  });

  await t.test("spraying one password across many accounts locks the source", async () => {
    // The per-account budget alone doesn't stop this: every attempt is against a
    // different account, so no account's budget is ever spent.
    const { client, app } = loadDbServerWith({
      loginFailuresPerAccount: 100, // deliberately out of the way
      loginFailuresPerSource: 3,
    });
    client.reset();

    for (const victim of ["alice", "bob", "carol"]) {
      const res = await call(app, "post", "/login", loginRequest(victim, "password123", "10.9.9.9"));
      assert.equal(res.statusCode, 401);
    }

    const locked = await call(app, "post", "/login", loginRequest("dave", "password123", "10.9.9.9"));
    assert.equal(locked.statusCode, 429, "the sprayer must be cut off by address");

    // ...and only that address. A shared lockout would be a way to lock the
    // whole bank's customers out by attacking it.
    client.reset();
    client.queueResponse({
      error: null,
      results: { rowCount: 1, rows: [{ friendlyid: "erin", password_hash: STORED }] },
    });
    const elsewhere = await call(
      app,
      "post",
      "/login",
      loginRequest("erin", PASSWORD, "192.168.1.50")
    );
    assert.equal(elsewhere.lastJson.msg, "SUCCESS!", "an unrelated customer is unaffected");
  });
});
