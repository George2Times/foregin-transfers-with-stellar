// Minimal in-memory fake of the `pg` package's Client, for offline unit
// testing of the DBServer*/Callbacks* route handlers without a real
// Postgres connection.
//
// Usage in a test:
//   const { Client } = require("./fakes/pg");
//   ... require the server module under test (it does `new pg.Client(...)`) ...
//   const client = Client.instances[Client.instances.length - 1];
//   client.queueResponse({ error: null, results: { rowCount: 1, rows: [...] } });

class FakeClient {
  constructor(conString) {
    this.conString = conString;
    this.connected = false;
    this.queries = []; // { sql, params } for every query made, for assertions
    this._queue = []; // queued { error, results } responses, consumed in order
    FakeClient.instances.push(this);
  }

  connect(cb) {
    this.connected = true;
    if (typeof cb === "function") cb(null);
  }

  end(cb) {
    this.connected = false;
    if (typeof cb === "function") cb(null);
  }

  // Test helper: program the next query's callback result.
  queueResponse(response) {
    this._queue.push(response);
  }

  // Test helper: clear recorded queries and any unconsumed queued
  // responses, without losing the instance's identity/closures.
  reset() {
    this.queries.length = 0;
    this._queue.length = 0;
  }

  query(sql, params, callback) {
    // pg supports query(sql, callback) with no params array.
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    this.queries.push({ sql, params });

    const next = this._queue.shift() || {
      error: null,
      results: { rowCount: 0, rows: [] },
    };

    // Defer, like a real DB round-trip, so tests exercise the same
    // async control flow as production.
    setImmediate(() => callback(next.error, next.results));
  }
}

FakeClient.instances = [];

module.exports = { Client: FakeClient };
