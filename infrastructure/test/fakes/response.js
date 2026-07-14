// Minimal fake of an Express `res` object, recording every call made to it
// so tests can assert on what a route handler sent back to the client.

function makeFakeResponse() {
  const res = {
    statusCode: 200,
    calls: [], // e.g. [{ method: "json", args: [...] }, ...]
    endCount: 0,
    lastJson: undefined,
    headers: {}, // whatever setHeader() was called with, for CORS assertions

    status(code) {
      res.statusCode = code;
      res.calls.push({ method: "status", args: [code] });
      return res;
    },
    json(obj) {
      res.lastJson = obj;
      res.calls.push({ method: "json", args: [obj] });
      return res;
    },
    end(msg) {
      res.endCount += 1;
      res.calls.push({ method: "end", args: [msg] });
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
      return res;
    },
  };

  return res;
}

module.exports = { makeFakeResponse };
