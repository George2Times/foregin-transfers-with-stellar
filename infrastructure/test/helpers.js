// Shared plumbing for the offline route tests.
//
// `loadServer` loads one of the real server files (DBServerA.js,
// CallbacksB.js, ...) with `express`/`pg`/`request`/`node-fetch` swapped for
// the fakes in ./fakes, and hands back the fake `app` and `client` that file
// built, so a test can invoke its actual route handlers and control what the
// "database" returns. Nothing here re-implements any behavior under test.

const path = require("path");

const { installMockRequire } = require("./mockRequire");
installMockRequire();

const express = require("./fakes/express");
const { Client } = require("./fakes/pg");

function loadServer(fileName) {
  const modulePath = path.join(__dirname, "..", fileName);
  const clientCountBefore = Client.instances.length;
  const appCountBefore = express.instances.length;

  delete require.cache[require.resolve(modulePath)];
  require(modulePath);

  return {
    client: Client.instances[clientCountBefore],
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

module.exports = { loadServer, waitFor, settle };
