// Redirects `require("express")`, `require("body-parser")`, `require("pg")`
// and `require("request")` to the hand-written fakes in ./fakes, so
// DBServerA.js / DBServerB.js / CallbacksA.js / CallbacksB.js can be loaded
// and their route handlers exercised in a test process with:
//   - no real npm packages installed (infrastructure/ has no node_modules),
//   - no real network calls,
//   - no real Postgres connection.
//
// This only patches Node's module resolution for the lifetime of the
// process running the test file that calls installMockRequire(); it does
// not touch any files on disk and is not a permanent change to how the
// project resolves modules.

const Module = require("module");
const path = require("path");

const MOCKS = {
  express: path.join(__dirname, "fakes", "express.js"),
  "body-parser": path.join(__dirname, "fakes", "body-parser.js"),
  pg: path.join(__dirname, "fakes", "pg.js"),
  request: path.join(__dirname, "fakes", "request.js"),
  "node-fetch": path.join(__dirname, "fakes", "node-fetch.js"),
};

let installed = false;

function installMockRequire() {
  if (installed) return;
  installed = true;

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCKS, request)) {
      return MOCKS[request];
    }
    return originalResolveFilename.call(this, request, ...rest);
  };
}

module.exports = { installMockRequire };
