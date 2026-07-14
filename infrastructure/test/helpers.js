// Shared plumbing for the offline route tests.
//
// `loadServer` loads one of the real server files (DBServerA.js,
// CallbacksB.js, ...) with `express`/`pg`/`request`/`node-fetch` swapped for
// the fakes in ./fakes, and hands back the fake `app` and `client` that file
// built, so a test can invoke its actual route handlers and control what the
// "database" returns. Nothing here re-implements any behavior under test.

const path = require("path");

// The DB servers refuse to start without a signing secret (auth.js's
// requireSessionSecret() calls process.exit(1)), so the test process has to
// provide one before any server file is loaded. This is a throwaway value that
// exists only inside the test run.
const TEST_SESSION_SECRET = "test-session-secret-not-a-real-one";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const { installMockRequire } = require("./mockRequire");
installMockRequire();

const express = require("./fakes/express");
const { instances: dbInstances } = require("./fakes/pg");

// `client` is whichever pg object the loaded file built -- a Client for the DB
// servers, a Pool for the callbacks. Both fakes take the same queueResponse() /
// queries interface, so tests don't care which one they got.
function loadServer(fileName) {
  const modulePath = path.join(__dirname, "..", fileName);
  const dbCountBefore = dbInstances.length;
  const appCountBefore = express.instances.length;

  delete require.cache[require.resolve(modulePath)];
  require(modulePath);

  return {
    client: dbInstances[dbCountBefore],
    app: express.instances[appCountBefore],
  };
}

// Builds a DB server straight from the shared factory with a caller-supplied
// config, for the handful of assertions that need a setting neither bank ships.
// Everything else should go through loadServer() and drive the real DBServerA/B
// files -- this is the same handler code either way, just configured differently.
function loadDbServerWith(overrides) {
  const { createDbServer } = require("../dbserver");
  const dbCountBefore = dbInstances.length;
  const appCountBefore = express.instances.length;

  createDbServer(
    Object.assign(
      {
        listened_port: 3999,
        domain: "*banka.com",
        conString: "postgres://test@localhost:5432/test",
        entryPointBS: "http://localhost:8006/payment",
        firstTxid: 1,
      },
      overrides
    )
  );

  return {
    client: dbInstances[dbCountBefore],
    app: express.instances[appCountBefore],
  };
}

// Resolves once `predicate()` is true, so a test can wait for a route handler's
// async DB callbacks to finish without guessing at a fixed sleep.
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

// Lets any already-scheduled async work run, so a test can catch a handler
// that wrongly *keeps going* after it was supposed to have stopped.
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The audience each bank mints its tokens for: its federation domain, the same
// value DBServerA.js / DBServerB.js pass to createDbServer as `domain`. Nothing
// keeps this map in step with those files, and nothing needs to -- get it wrong
// and every authenticated request in every suite comes back 401.
const AUDIENCE = {
  "DBServerA.js": "*banka.com",
  "DBServerB.js": "*bankb.com",
};

function audienceFor(file) {
  const audience = AUDIENCE[file];
  if (!audience) throw new Error("helpers: no audience known for " + file);
  return audience;
}

// Builds the Authorization header a request needs to reach a protected route,
// signed with the same secret the loaded servers are using. `audience` is which
// bank the token is good at -- pass audienceFor(theServerFileUnderTest), or one
// deliberately belonging to the *other* bank to check that it is turned away.
function authHeader(friendlyid, audience) {
  const auth = require("../auth");
  return {
    authorization: "Bearer " + auth.issueToken(friendlyid, TEST_SESSION_SECRET, audience),
  };
}

module.exports = {
  loadServer,
  loadDbServerWith,
  waitFor,
  settle,
  authHeader,
  audienceFor,
  TEST_SESSION_SECRET,
};
