// Minimal fake of the `request` package's `.post()`, for offline unit
// testing of DBServerA.js / DBServerB.js's calls out to the bridge server,
// without making a real HTTP call.

const calls = [];
let queue = [];

function post(opts, callback) {
  calls.push(opts);
  const next = queue.shift() || {
    err: null,
    res: { statusCode: 200 },
    body: "{}",
  };
  setImmediate(() => callback(next.err, next.res, next.body));
}

function queueResponse(response) {
  queue.push(response);
}

function reset() {
  calls.length = 0;
  queue = [];
}

module.exports = { post, calls, queueResponse, reset };
