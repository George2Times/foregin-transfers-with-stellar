// Minimal in-memory fake of the `express` package, just enough to load
// DBServerA.js / DBServerB.js / CallbacksA.js / CallbacksB.js and invoke
// their route handlers directly in tests, without a real HTTP server.
//
// Not a real dependency -- hand-written for offline unit testing only.
// Wired up via infrastructure/test/mockRequire.js (Module._resolveFilename
// hook), not via node_modules, so it is not confused with a real package.

// Runs a route's handler chain the way express does: each handler may either
// respond (ending the chain) or call next() to pass control on. This is what
// makes route-level middleware -- app.post("/payment", requireAuth, handler) --
// behave in tests the way it does in production: if requireAuth answers 401,
// the real handler never runs.
function chain(handlers) {
  return function (request, response) {
    let index = 0;
    function next() {
      const handler = handlers[index++];
      if (handler) handler(request, response, next);
    }
    next();
  };
}

function makeApp() {
  const routes = { get: {}, post: {} };
  const middleware = [];

  const app = {
    use(fn) {
      middleware.push(fn);
      return app;
    },
    get(path, ...handlers) {
      routes.get[path] = chain(handlers);
      return app;
    },
    post(path, ...handlers) {
      routes.post[path] = chain(handlers);
      return app;
    },
    listen(port, cb) {
      const fakeServer = { address: () => ({ port: port || 0 }) };
      // Real express/http invoke the listen callback asynchronously, after
      // `.listen()` has already returned and been assigned by the caller
      // (e.g. `var server = app.listen(port, function () { server.address() })`).
      // Match that timing so callers relying on it don't break.
      if (typeof cb === "function") setImmediate(() => cb.call(fakeServer));
      return fakeServer;
    },
    // Test helper (not part of the real express API): fetch a registered
    // route handler so a test can invoke it directly.
    _getRoute(method, path) {
      return routes[method] && routes[method][path];
    },
    // Test helper: the app-level middleware stack, in registration order, so a
    // test can exercise e.g. the CORS middleware on its own.
    _getMiddleware() {
      return middleware.slice();
    },
  };

  return app;
}

function express() {
  const app = makeApp();
  express.instances.push(app);
  return app;
}

// Test helper: every app created via express(), in creation order, so a
// test can grab the one that a just-`require()`d server file built.
express.instances = [];

module.exports = express;
