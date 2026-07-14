// Tests for the code in App.js that actually moves money: login, setAccount,
// payment, setBalance and setBank.
//
// Until now the front end's only tests covered two presentational components
// (AddressBar, InputField). Everything that talks to the bank server -- the
// balance check, the transfer, the bearer token that decides *whose* account
// gets spent -- had no coverage at all, on either page.
//
// These drive the real component methods against a faked `fetch`, so they
// assert what the browser would actually send and what the user would actually
// be told. Nothing here re-implements App.js. The identical suite runs in
// pageB: the two App.js files differ only in a port number and a display name,
// and testing one and eyeballing the other is how a fix ends up half-applied.

import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import App from "./App";

// App.js builds a StellarSdk.Asset in its constructor and a StellarSdk.Server
// in componentDidMount. Neither is involved in the payment flow -- the money
// moves over the bank server's REST API -- and loading the real SDK in a test
// process is slow and wants a network. Stub it out.
jest.mock("stellar-sdk", () => ({
  Asset: function Asset(code, issuer) {
    this.code = code;
    this.issuer = issuer;
  },
  Server: function Server() {},
}));

let container;
let app;

// A fetch Response, near enough: the App only ever reads .ok and .json().
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

// The App is promise-driven, so a method returns before its state settles.
// Wrapping the call in an async act() flushes the pending microtasks and lets
// React apply the setState()s before we assert.
async function drive(fn) {
  await act(async () => {
    await fn();
  });
}

// The body of the nth fetch call, decoded.
function sentBody(index) {
  return JSON.parse(global.fetch.mock.calls[index][1].body);
}

function sentHeaders(index) {
  return global.fetch.mock.calls[index][1].headers;
}

function calledUrls() {
  return global.fetch.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  global.fetch = jest.fn();

  act(() => {
    app = ReactDOM.render(<App />, container);
  });
});

afterEach(() => {
  ReactDOM.unmountComponentAtNode(container);
  container.remove();
  container = null;
  jest.resetAllMocks();
});

// Puts the app in the state it's in after a successful login, so the money
// tests don't each have to log in first.
function signedIn(token = "a-valid-token") {
  act(() => {
    app.setState({ token, account: "alice*banka.com" });
  });
}

function typeInto(fields) {
  act(() => {
    Object.entries(fields).forEach(([name, value]) => {
      app.onInputChangeUpdateField(name, value);
    });
  });
}

describe("payment()", () => {
  test("refuses an empty receiver, and doesn't bother the server", async () => {
    signedIn();
    typeInto({ amount: "10" });

    await drive(() => app.payment());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(app.state.txstatus).toBe("Enter a receiver");
  });

  // The server rejects these too -- it must, since it can't trust a browser --
  // but a negative amount used to be accepted by both, and *credited* the
  // sender rather than debiting them.
  test.each([["-100"], ["-0.01"], ["0"], ["abc"], [""], ["  "]])(
    "refuses the amount %p, and doesn't bother the server",
    async (amount) => {
      signedIn();
      typeInto({ receiver: "bob*bankb.com", amount });

      await drive(() => app.payment());

      expect(global.fetch).not.toHaveBeenCalled();
      expect(app.state.txstatus).toBe("Enter a positive amount");
    }
  );

  test("sends the receiver, the amount and the bearer token", async () => {
    signedIn("token-for-alice");
    typeInto({ receiver: "bob*bankb.com", amount: "12.75" });
    global.fetch
      .mockReturnValueOnce(jsonResponse({ msg: "SUCCESS!", result: '{"hash":"abc123"}' }))
      .mockReturnValueOnce(jsonResponse({ balance: 87.25 })); // the setBalance() refresh

    await drive(() => app.payment());

    expect(calledUrls()[0]).toContain("/payment");
    expect(sentBody(0)).toEqual({ receiver: "bob*bankb.com", amount: "12.75" });
    expect(sentHeaders(0).Authorization).toBe("Bearer token-for-alice");
  });

  // The whole point of the auth work: the account is taken from the token, and
  // naming one in the body used to be all it took to spend someone else's money.
  // If an `account` field ever reappears here, that's the shape of the old hole.
  test("does not name an account in the request body", async () => {
    signedIn();
    typeInto({ receiver: "bob*bankb.com", amount: "10" });
    global.fetch
      .mockReturnValueOnce(jsonResponse({ msg: "SUCCESS!", result: '{"hash":"abc123"}' }))
      .mockReturnValueOnce(jsonResponse({ balance: 90 }));

    await drive(() => app.payment());

    expect(sentBody(0)).not.toHaveProperty("account");
    expect(sentBody(0)).not.toHaveProperty("friendlyid");
  });

  test("reports the transaction hash and refreshes the balance on success", async () => {
    signedIn();
    typeInto({ receiver: "bob*bankb.com", amount: "10" });
    global.fetch
      .mockReturnValueOnce(jsonResponse({ msg: "SUCCESS!", result: '{"hash":"abc123"}' }))
      .mockReturnValueOnce(jsonResponse({ balance: 90 }));

    await drive(() => app.payment());

    expect(app.state.txstatus).toBe("Transaction Successful");
    expect(app.state.txid).toBe("abc123");
    // A sent payment must not leave a stale balance on screen.
    expect(calledUrls()[1]).toContain("/userbal");
    expect(app.state.balance).toBe(90);
  });

  test("surfaces the server's reason when it refuses the payment", async () => {
    signedIn();
    typeInto({ receiver: "bob*bankb.com", amount: "10000" });
    global.fetch.mockReturnValueOnce(
      jsonResponse({ msg: "ERROR!", error_msg: "Insufficient balance!" })
    );

    await drive(() => app.payment());

    expect(app.state.txstatus).toBe("Transaction Failed: Insufficient balance!");
    // A failed payment must not refresh (or clear) the balance.
    expect(calledUrls()).toHaveLength(1);
  });

  // The bank server being unreachable is the ordinary way this fails. It used
  // to fail silently: the `.then(function (response, error) {...})` shape never
  // received an error, so the user was told nothing at all.
  test("tells the user when the bank server can't be reached", async () => {
    signedIn();
    typeInto({ receiver: "bob*bankb.com", amount: "10" });
    global.fetch.mockReturnValueOnce(Promise.reject(new Error("Failed to fetch")));

    await drive(() => app.payment());

    expect(app.state.txstatus).toBe("Transaction Failed: could not reach the bank server");
  });
});

describe("login()", () => {
  test("requires both a friendly ID and a password", async () => {
    typeInto({ friendlyid: "alice", password: null });

    await drive(() => app.login());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(app.state.loginerror).toBe("Friendly ID and password are required");
  });

  test("keeps the token and loads the account on success", async () => {
    typeInto({ friendlyid: "alice", password: "hunter2" });
    global.fetch
      .mockReturnValueOnce(jsonResponse({ msg: "SUCCESS!", token: "fresh-token" }))
      .mockReturnValueOnce(jsonResponse({ name: "Alice", balance: 100 })); // setAccount()

    await drive(() => app.login());

    expect(calledUrls()[0]).toContain("/login");
    expect(sentBody(0)).toEqual({ friendlyid: "alice", password: "hunter2" });
    expect(app.state.token).toBe("fresh-token");
    expect(app.state.loginerror).toBe(null);
    // The account details are fetched with the token we just got.
    expect(calledUrls()[1]).toContain("/userdet");
    expect(sentHeaders(1).Authorization).toBe("Bearer fresh-token");
    expect(app.state.name).toBe("Alice");
    expect(app.state.balance).toBe(100);
  });

  test("holds no token when the credentials are refused", async () => {
    typeInto({ friendlyid: "alice", password: "wrong" });
    global.fetch.mockReturnValueOnce(
      jsonResponse({ msg: "ERROR!", error_msg: "Invalid credentials" }, { ok: false, status: 401 })
    );

    await drive(() => app.login());

    expect(app.state.loginerror).toBe("Login failed");
    expect(app.state.token).toBe(null);
    expect(app.state.account).toBe(null);
    // A refused login must not go on to request an account.
    expect(calledUrls()).toHaveLength(1);
  });

  test("tells the user when the bank server can't be reached", async () => {
    typeInto({ friendlyid: "alice", password: "hunter2" });
    global.fetch.mockReturnValueOnce(Promise.reject(new Error("Failed to fetch")));

    await drive(() => app.login());

    expect(app.state.loginerror).toBe("Could not reach the bank server");
    expect(app.state.token).toBe(null);
  });
});

describe("setAccount()", () => {
  test("fills in the name and balance", async () => {
    signedIn();
    global.fetch.mockReturnValueOnce(jsonResponse({ name: "Alice", balance: 250.5 }));

    await drive(() => app.setAccount("alice*banka.com"));

    expect(calledUrls()[0]).toContain("/userdet");
    expect(app.state.account).toBe("alice*banka.com");
    expect(app.state.name).toBe("Alice");
    expect(app.state.balance).toBe(250.5);
  });

  // A 401 means the token is no good. Holding on to it would leave the UI
  // looking signed in while every call it makes is refused.
  test("drops the token when the server refuses the request", async () => {
    signedIn("stale-token");
    global.fetch.mockReturnValueOnce(
      jsonResponse({ msg: "ERROR!" }, { ok: false, status: 401 })
    );

    await drive(() => app.setAccount("alice*banka.com"));

    expect(app.state.token).toBe(null);
    expect(app.state.loginerror).toBe("Could not load account");
  });
});

describe("setBalance()", () => {
  test("updates the balance with the token", async () => {
    signedIn("token-for-alice");
    global.fetch.mockReturnValueOnce(jsonResponse({ balance: 42.5 }));

    await drive(() => app.setBalance());

    expect(calledUrls()[0]).toContain("/userbal");
    expect(sentHeaders(0).Authorization).toBe("Bearer token-for-alice");
    expect(app.state.balance).toBe(42.5);
  });
});

describe("setBank()", () => {
  test("stores the transaction list", async () => {
    signedIn();
    const tx = [{ txid: "1001", amount: "10", sender: "bob*bankb.com" }];
    global.fetch.mockReturnValueOnce(jsonResponse({ tx }));

    await drive(() => app.setBank());

    expect(calledUrls()[0]).toContain("/bankuser");
    expect(app.state.receivedtx).toEqual(tx);
  });
});
