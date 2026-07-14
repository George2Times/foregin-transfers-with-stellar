// Minimal fake of the `node-fetch` package. It stands in for every outbound
// HTTP call the servers make: CallbacksA/B's /test stellar.toml lookup, and
// DBServerA/B's form-encoded POST to the bridge (which used to go through the
// deprecated `request` package).
//
// Default behavior is to reject: an *unqueued* call means a test is about to
// make a real HTTP call, and that should fail loudly rather than quietly reach
// the network. A test that wants to drive one of those routes queues the outcome
// it wants first -- including a rejection, which is how these fail in production
// (the far host being unreachable) and the case the routes used to swallow.

const outcomes = [];

function fetch(url, options) {
  fetch.calls.push({ url: url, options: options || {} });

  if (outcomes.length === 0) {
    return Promise.reject(
      new Error("node-fetch fake: no test should be making a real HTTP call")
    );
  }

  const next = outcomes.shift();
  return next.reject ? Promise.reject(next.value) : Promise.resolve(next.value);
}

// Every call made, in order, as { url, options }.
fetch.calls = [];

// Test helper: the decoded form fields of the nth call, for the routes that POST
// application/x-www-form-urlencoded (the bridge call).
fetch.formOf = function (index) {
  const call = fetch.calls[index];
  return Object.fromEntries(new URLSearchParams(call.options.body));
};

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
