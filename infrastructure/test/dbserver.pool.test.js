// Offline tests that the DB servers can survive losing their database
// connection.
//
// They used to hold a single `pg.Client`, connected once at startup, with no
// reconnect logic anywhere. If that one connection dropped -- a database restart
// is the ordinary way -- every subsequent query failed forever and only a manual
// restart of the process brought the server back. Nothing in the code noticed or
// retried.
//
// These pin the two properties that make a DB bounce survivable, and both fail
// against the pre-fix source (which built a pg.Client and registered no error
// handler at all).

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServer } = require("./helpers");
const pgFake = require("./fakes/pg");

for (const file of ["DBServerA.js", "DBServerB.js"]) {
  test(`${file} survives a dropped database connection`, async (t) => {
    const { client: db } = loadServer(file);

    await t.test("holds a pool, not a single Client that never reconnects", () => {
      assert.ok(
        db instanceof pgFake.Pool,
        "a pg.Client is established once and never re-established; a pool " +
          "replaces a broken connection on the next query"
      );
      assert.ok(!(db instanceof pgFake.Client));
    });

    await t.test("an idle client erroring out doesn't take the process down", () => {
      const onError = db._handlers && db._handlers.error;
      assert.equal(
        typeof onError,
        "function",
        "an unhandled 'error' event from a pooled client is an uncaught " +
          "exception, which kills the server -- exactly the outage the pool is here to prevent"
      );
      assert.doesNotThrow(function () {
        onError(new Error("terminating connection due to administrator command"));
      });
    });
  });
}
