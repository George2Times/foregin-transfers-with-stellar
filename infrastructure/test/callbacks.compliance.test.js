// Offline tests for the sanctions-screening gate in CallbacksA.js /
// CallbacksB.js (/compliance/sanctions and /compliance/ask_user).
//
// Background: both routes used to respond 200 (approved) no matter what the
// `sanction` lookup returned -- /compliance/sanctions ignored the rows entirely
// and /compliance/ask_user had its real check commented out. No transaction
// could ever be blocked. These tests pin down that the gate now actually
// denies, and that it fails closed on every path where it can't prove approval.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer, waitFor, settle } = require("./helpers");
const { makeFakeResponse } = require("./fakes/response");

const ROUTES = ["/compliance/sanctions", "/compliance/ask_user"];

function senderRequest(domain) {
  return { body: { sender: JSON.stringify({ domain: domain }) } };
}

for (const file of ["CallbacksA.js", "CallbacksB.js"]) {
  test(`${file} sanctions screening`, async (t) => {
    const { client, app } = loadServer(file);

    for (const route of ROUTES) {
      const handler = app._getRoute("post", route);
      assert.ok(typeof handler === "function", `${route} must be registered`);

      await t.test(`${route}: approves an FI flagged sanction = true`, async () => {
        client.reset();
        client.queueResponse({
          error: null,
          results: {
            rowCount: 1,
            rows: [{ domain: "banka.com", bankname: "Bank A", sanction: true }],
          },
        });

        const res = makeFakeResponse();
        handler(senderRequest("banka.com"), res);
        await waitFor(() => res.endCount > 0);

        assert.equal(res.statusCode, 200);
      });

      await t.test(`${route}: DENIES an FI flagged sanction = false`, async () => {
        client.reset();
        client.queueResponse({
          error: null,
          results: {
            rowCount: 1,
            rows: [{ domain: "evil.com", bankname: "Evil Bank", sanction: false }],
          },
        });

        const res = makeFakeResponse();
        handler(senderRequest("evil.com"), res);
        await waitFor(() => res.endCount > 0);

        assert.equal(res.statusCode, 403, "a sanctioned FI must be blocked");
      });

      await t.test(`${route}: DENIES an FI that has no row at all`, async () => {
        client.reset();
        client.queueResponse({ error: null, results: { rowCount: 0, rows: [] } });

        const res = makeFakeResponse();
        handler(senderRequest("unknown.com"), res);
        await waitFor(() => res.endCount > 0);

        assert.equal(res.statusCode, 403, "an unscreenable FI must not be approved");
      });

      await t.test(`${route}: fails closed when the lookup errors`, async () => {
        client.reset();
        client.queueResponse({ error: new Error("connection lost"), results: null });

        const res = makeFakeResponse();
        handler(senderRequest("banka.com"), res);
        await waitFor(() => res.endCount > 0);
        await settle();

        assert.notEqual(res.statusCode, 200, "a failed screening must never approve");
        assert.equal(res.endCount, 1, "response must be ended exactly once");
      });

      await t.test(`${route}: rejects a malformed sender instead of crashing`, async () => {
        client.reset();

        const res = makeFakeResponse();
        handler({ body: { sender: "not json" } }, res);
        await settle();

        assert.equal(res.statusCode, 400);
        assert.equal(client.queries.length, 0, "must not query on malformed input");
      });
    }
  });
}
