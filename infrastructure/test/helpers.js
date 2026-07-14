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

// Builds the Authorization header a request needs to reach a protected route,
// signed with the same secret the loaded servers are using.
function authHeader(friendlyid) {
  const auth = require("../auth");
  return { authorization: "Bearer " + auth.issueToken(friendlyid, TEST_SESSION_SECRET) };
}

module.exports = { loadServer, waitFor, settle, authHeader, TEST_SESSION_SECRET };
