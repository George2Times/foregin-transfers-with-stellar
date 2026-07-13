// Minimal in-memory fake of the `pg` package, for offline unit testing of the
// DBServer* / Callbacks* route handlers without a real Postgres connection.
//
// Exposes both shapes the servers use:
//   - Client: DBServerA/B hold a single long-lived client.
//   - Pool:   CallbacksA/B need pool.connect() for /receive's BEGIN/COMMIT.
//
// Both record every query and consume the same queue of programmed results, so
// a test can drive either one identically:
//
//   const { instances } = require("./fakes/pg");
//   ... require the server module under test ...
//   const db = instances[instances.length - 1];
//   db.queueResponse({ error: null, results: { rowCount: 1, rows: [...] } });
//   ... db.queries is [{ sql, params }, ...] afterwards, for assertions.

// Shared behavior: a recorded query log, and a FIFO of programmed responses.
class FakeQueryable {
  constructor(config) {
    this.config = config;
    this.queries = []; // { sql, params } for every query made, for assertions
    this._queue = []; // queued { error, results }, consumed in order
    instances.push(this);
  }

  // Test helper: program the next query's result. Queue them in the order the
  // handler under test will issue them.
  queueResponse(response) {
    this._queue.push(response);
  }

  // Test helper: clear recorded queries and any unconsumed responses, without
  // losing this instance's identity (the server file closed over it).
  reset() {
    this.queries.length = 0;
    this._queue.length = 0;
  }

  // Test helper: the SQL of every query issued so far, for order assertions.
  sqlLog() {
    return this.queries.map((q) => q.sql);
  }

  _next(sql, params) {
    this.queries.push({ sql, params });
    return (
      this._queue.shift() || {
        error: null,
        results: { rowCount: 0, rows: [] },
      }
    );
  }

  // pg's query() is callback-style when given a callback, promise-style
  // otherwise. Both are used in this codebase, so support both.
  query(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    const next = this._next(sql, params);

    if (typeof callback === "function") {
      // Defer, like a real DB round-trip, so tests exercise the same async
      // control flow as production.
      setImmediate(() => callback(next.error, next.results));
      return undefined;
    }

    return new Promise((resolve, reject) => {
      setImmediate(() => {
        if (next.error) reject(next.error);
        else resolve(next.results);
      });
    });
  }
}

class FakeClient extends FakeQueryable {
  constructor(conString) {
    super(conString);
    this.connected = false;
  }

  connect(cb) {
    this.connected = true;
    if (typeof cb === "function") cb(null);
  }

  end(cb) {
    this.connected = false;
    if (typeof cb === "function") cb(null);
  }
}

class FakePool extends FakeQueryable {
  constructor(config) {
    super(config);
    this.released = 0; // how many borrowed connections were handed back
    this.borrowed = 0;
    this._handlers = {};
  }

  on(event, handler) {
    this._handlers[event] = handler;
    return this;
  }

  // Hands out a connection backed by this same query log and response queue,
  // so a test programs a pool and its connections as one thing. `released`
  // lets a test assert the handler doesn't leak connections on its error paths.
  connect() {
    this.borrowed += 1;
    const pool = this;
    const connection = {
      query: (sql, params, callback) => pool.query(sql, params, callback),
      release: () => {
        pool.released += 1;
      },
    };
    return Promise.resolve(connection);
  }

  end() {
    return Promise.resolve();
  }
}

// Every Client/Pool built, in construction order, so a test can grab the one a
// just-require()d server file created.
const instances = [];

FakeClient.instances = instances;

module.exports = { Client: FakeClient, Pool: FakePool, instances };
