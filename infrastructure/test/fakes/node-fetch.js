// Minimal fake of the `node-fetch` package. CallbacksA.js / CallbacksB.js
// require it at module load for their /test route.
//
// Default behavior is to reject: an *unqueued* call means a test is about to
// make a real HTTP call, and that should fail loudly rather than quietly reach
// the network. A test that wants to drive the /test route queues the outcome it
// wants first -- including a rejection, which is how this fails in production
// (the bridge host being unreachable) and the case the route used to swallow.

const outcomes = [];

function fetch(url) {
  fetch.calls.push(url);

  if (outcomes.length === 0) {
    return Promise.reject(
      new Error("node-fetch fake: no test should be making a real HTTP call")
    );
  }

  const next = outcomes.shift();
  return next.reject ? Promise.reject(next.value) : Promise.resolve(next.value);
}

// Every URL fetch() was called with, in order.
fetch.calls = [];

// Resolve the next call with a fetch-like Response.
fetch.queueResponse = function ({ ok = true, status = 200, text = "" } = {}) {
  outcomes.push({
    reject: false,
    value: { ok, status, text: () => Promise.resolve(text) },
  });
};

// Reject the next call, the way a refused connection or a DNS failure does.
fetch.queueRejection = function (error) {
  outcomes.push({ reject: true, value: error });
};

fetch.reset = function () {
  outcomes.length = 0;
  fetch.calls = [];
};

module.exports = fetch;
