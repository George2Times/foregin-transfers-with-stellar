// Offline tests for the /test route in CallbacksA.js / CallbacksB.js.
//
// Background: the route was written as
//     fetch(url).then(function (response, error) { if (response) { ... } })
// which is the broken promise idiom this pass set out to remove. `.then` hands
// its callback exactly one argument -- the resolved value -- so `error` was
// always `undefined`, and the chain carried no `.catch` at all. A rejected
// fetch, which is the ordinary way this fails when the looked-up host is down,
// therefore produced *no reply whatsoever*: the caller hung until its own
// timeout and the only trace was an unhandled-rejection warning on stderr.
//
// These tests pin down that every outcome -- success, non-2xx, and rejection --
// now answers the caller. The rejection case is the one that fails against the
// pre-fix source, and it fails by timing out in waitFor(), which is exactly the
// symptom the bug produced in production.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer, waitFor } = require("./helpers");
const { makeFakeResponse } = require("./fakes/response");
const fetch = require("./fakes/node-fetch");

const TOML = 'FEDERATION_SERVER="https://banka.com/federation"';

// The handler answers with response.json(), which the fake records as a call
// but not as an end() -- so "it responded" means "it said anything at all".
function responded(res) {
  return () => res.calls.length > 0;
}

for (const file of ["CallbacksA.js", "CallbacksB.js"]) {
  test(`${file} /test`, async (t) => {
    const { app } = loadServer(file);

    const handler = app._getRoute("post", "/test");
    assert.ok(typeof handler === "function", "/test must be registered");

    await t.test("returns the stellar.toml body on success", async () => {
      fetch.reset();
      fetch.queueResponse({ ok: true, status: 200, text: TOML });

      const res = makeFakeResponse();
      handler({ body: {} }, res);
      await waitFor(responded(res));

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.lastJson, { data: TOML });
    });

    await t.test("answers 502 when the lookup is refused", async () => {
      fetch.reset();
      fetch.queueRejection(new Error("ECONNREFUSED"));

      const res = makeFakeResponse();
      handler({ body: {} }, res);
      await waitFor(responded(res));

      assert.equal(res.statusCode, 502);
      assert.equal(res.lastJson.msg, "ERROR!");
    });

    await t.test("answers 502 when the lookup returns a non-2xx status", async () => {
      fetch.reset();
      fetch.queueResponse({ ok: false, status: 404, text: "not found" });

      const res = makeFakeResponse();
      handler({ body: {} }, res);
      await waitFor(responded(res));

      assert.equal(res.statusCode, 502);
      assert.equal(res.lastJson.msg, "ERROR!");
    });

    await t.test("does not pass a failed lookup off as data", async () => {
      fetch.reset();
      fetch.queueRejection(new Error("ECONNREFUSED"));

      const res = makeFakeResponse();
      handler({ body: {} }, res);
      await waitFor(responded(res));

      // The old shape's `if (response)` guard fell through to the next .then
      // with `data` undefined, so a failed lookup could still be reported to
      // the caller as a successful one carrying no toml.
      assert.equal(res.lastJson.data, undefined);
      assert.notEqual(res.statusCode, 200);
    });
  });
}
