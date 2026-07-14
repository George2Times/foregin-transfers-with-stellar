// The bank-facing API, written once and configured twice.
//
// DBServerA.js and DBServerB.js used to be near-byte-for-byte copies of each
// other, differing only in the constants at the top. Every fix in HARDENING.md
// and every fix in the 2026-07-14 hardening pass had to be hand-applied to both
// of them, and the one time that slipped (the /payment tests) the two copies
// quietly drifted apart. Both files are now thin config that calls this factory,
// so a fix here lands on both banks by construction rather than by discipline.
//
// Anything genuinely per-bank is a field of `config`. Anything else lives here.

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const pg = require("pg");
const { parseAmount } = require("./money");
const auth = require("./auth");

// Properties of the asset being moved, not of either bank: both servers send
// the same USD credit issued by the same account.
const USD = "USD";
const ISSUER = "GAIHBCB57M2SDFQYUMANDBHW4YYMD3FJVK2OGHRKKCNF2HBZIRBKRX6E";

// config: { listened_port, domain, conString, entryPointBS, firstTxid }
function createDbServer(config) {
  const app = express();
  const domain = config.domain;

  // A pool, not a single Client.
  //
  // The old `new pg.Client(conString)` + `client.connect()` opened exactly one
  // connection at startup and never opened another. Nothing reconnected: if that
  // connection dropped -- the database restarting is the ordinary way this
  // happens, and it needn't even be a crash -- every subsequent query on this
  // server failed forever, and the only cure was a manual restart of the
  // process. A pool discards a broken connection and establishes a new one on
  // the next query, so the server rides out a database bounce instead of being
  // permanently bricked by it.
  //
  // CallbacksA/B already moved to a pool because /receive's transaction needed a
  // connection to itself. This is the same change for the other reason.
  const pool = new pg.Pool({ connectionString: config.conString });
  pool.on("error", function (error) {
    // An idle client erroring out (again: a DB restart) must not take the
    // process down with an unhandled 'error' event. The pool has already
    // discarded it; the next query gets a fresh connection.
    console.error("postgres pool error:", error);
  });

  app.use(bodyParser.json());
  app.use(
    bodyParser.urlencoded({
      extended: true,
    })
  );

  // Refuses to start if SESSION_SECRET isn't set: a hardcoded fallback signing
  // key would let anyone who has read this repo mint a token for any account.
  const sessionSecret = auth.requireSessionSecret();
  const requireAuth = auth.requireAuth(sessionSecret);

  // Was `Access-Control-Allow-Origin: *`, which let any website in the world call
  // these endpoints from a visitor's browser. Now an allow-list (ALLOWED_ORIGINS).
  app.use(auth.corsMiddleware(auth.allowedOriginsFromEnv()));

  var server = app.listen(process.env.PORT || config.listened_port, function () {
    var port = server.address().port;
    console.log("App now running on port", port);
  });

  // Each bank starts its payment ids in its own range so the two banks' ids
  // don't collide.
  var txid = config.firstTxid;

  // Exchanges a friendly ID + password for a bearer token. This is the only route
  // that takes an account name from the request body, because it's the only one
  // that makes the caller prove the account is theirs.
  app.post("/login", function (request, response) {
    console.log("/login: ");
    var friendlyid = request.body.friendlyid;
    var password = request.body.password;

    if (!friendlyid || !password) {
      response.status(400).json({ msg: "ERROR!", error_msg: "Missing friendlyid or password" });
      return;
    }

    var ID = String(friendlyid).split("*")[0];

    pool.query(
      "SELECT friendlyid,password_hash FROM users WHERE friendlyid = $1", [ID],
      (error, results) => {
        if (error) {
          console.error(error);
          response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
          return;
        }

        // Same answer whether the account doesn't exist, has no password set, or
        // the password is wrong -- otherwise this route tells an attacker which
        // friendly IDs are real.
        var storedHash = results.rowCount === 0 ? null : results.rows[0].password_hash;
        if (!auth.verifyPassword(password, storedHash)) {
          console.log("/login: rejected", ID);
          response.status(401).json({ msg: "ERROR!", error_msg: "Invalid credentials" });
          return;
        }

        console.log("/login: authenticated", ID);
        response.json({
          msg: "SUCCESS!",
          token: auth.issueToken(ID, sessionSecret),
          expires_in: auth.TOKEN_TTL_SECONDS,
        });
      }
    );
  });

  app.post("/userdet", requireAuth, function (request, response) {
    console.log("/userdet: ");
    {
      // The account comes from the verified token, not the request body. Sending
      // someone else's friendly ID used to be enough to read their name, address,
      // date of birth and balance.
      var ID = request.auth.friendlyid;

      console.log("ID:", ID);
      // You need to create `accountDatabase.findByFriendlyId()`. It should look
      // up a customer by their Stellar account and return account information.

      pool.query(
        "SELECT name,address,dob,balance FROM users WHERE friendlyid = $1", [ID],
        (error, results) => {
          if (error) {
            console.error(error);
            response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
            return;
          }
          console.log("query response rowCount:", results.rowCount);
          if (results.rowCount != 0) {
            var answer = {
              // response: results,
              name: results.rows[0].name,
              address: results.rows[0].address,
              date_of_birth: results.rows[0].dob,
              balance: results.rows[0].balance,
            };
            console.log("query answer:", answer);
            response.json(answer);
            response.end();
          } else {
            response.status(404).json({ msg: "ERROR!", error_msg: "User not found" });
          }
        }
      );
    }
  });

  app.post("/userbal", requireAuth, function (request, response) {
    console.log("/userbal: ");
    {
      // Token, not body -- reading another customer's balance used to be a matter
      // of typing their friendly ID.
      var ID = request.auth.friendlyid;

      console.log("ID:", ID);

      pool.query(
        "SELECT balance FROM users WHERE friendlyid = $1", [ID],
        (error, results) => {
          if (error) {
            console.error(error);
            response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
            return;
          }
          if (results) {
            console.log("query response rowCount:", results.rowCount);
            if (results.rowCount != 0) {
              var answer = {
                // response: results,{
                balance: results.rows[0].balance,
              };
              console.log("query answer:", answer);
              response.json(answer);
              response.end();
            } else {
              response.status(404).json({ msg: "ERROR!", error_msg: "User not found" });
            }
          }
        }
      );
    }
  });

  app.post("/payment", requireAuth, function (request, response) {
    console.log("/payment: ");

    // Every one of these used to fall off the end of the handler with no
    // response at all, hanging the caller until its own timeout.
    if (!request.body.receiver) {
      console.log("request.body.receiver:", request.body.receiver);
      response.status(400).json({ msg: "ERROR!", error_msg: "Missing receiver" });
      return;
    }

    // The amount was previously used unvalidated. `balance < Number(amount)` is
    // false for a negative amount, so the balance check passed, and the debit
    // `balance + -amount` then *raised* the sender's balance -- a negative
    // transfer was free money. A non-numeric amount made that expression NaN and
    // wrote NaN into the balance column. Both are rejected here, before anything
    // reaches the bridge.
    var amount = parseAmount(request.body.amount);
    if (amount === null) {
      console.log("invalid amount:", request.body.amount);
      response.status(400).json({
        msg: "ERROR!",
        error_msg: "Amount must be a positive number",
      });
      return;
    }

    // The sender is whoever the token says it is. It used to be whatever account
    // the request body named -- so any caller could spend any account's money
    // just by putting someone else's friendly ID in the `account` field.
    var ID = request.auth.friendlyid;
    var friendlyid = ID + domain;
    console.log("friendlyid:", friendlyid);
    console.log("ID:", ID);
    console.log("amount:", amount);

    // Reserve the funds up front, in one statement, and only then call the bridge.
    //
    // The old flow was SELECT balance -> compare -> call the bridge -> SELECT
    // balance again -> UPDATE to <that value> - amount. Two problems, both of
    // which let an account spend money it doesn't have:
    //   - The check and the write were separate statements, so two concurrent
    //     payments could both read the same balance, both pass the check, and
    //     both write, each overwriting the other's debit (lost update).
    //   - The check happened *before* the bridge call and the debit only after
    //     it came back, so even an atomic debit would leave a window in which a
    //     second payment passed the check against money the first was spending.
    //
    // `UPDATE ... WHERE balance >= $1` does the check and the debit as a single
    // statement: Postgres takes a row lock, and a concurrent update re-evaluates
    // the WHERE clause against the already-debited row. rowCount 0 means the
    // debit did not apply -- no such account, or not enough money. Nothing is
    // sent to the bridge until the money is provably set aside.
    pool.query(
      "UPDATE users SET balance = balance - $1 WHERE friendlyid = $2 AND balance >= $1", [amount, ID],
      (error, results) => {
        if (error) {
          console.error("failed to reserve funds:", error);
          response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
          return;
        }

        if (results.rowCount === 0) {
          // The debit didn't apply. Work out which of the two reasons it was, so
          // the caller still gets the 404 / "Insufficient balance!" it expects.
          pool.query(
            "SELECT balance from users where friendlyid = $1", [ID],
            (lookupError, lookupResults) => {
              if (lookupError) {
                console.error(lookupError);
                response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
                return;
              }
              if (lookupResults.rowCount === 0) {
                console.log("no such account:", ID);
                response.status(404).json({ msg: "ERROR!", error_msg: "Account not found" });
                return;
              }
              console.log("insufficient balance:", lookupResults.rows[0].balance, "<", amount);
              response.json({
                msg: "ERROR!",
                error_msg: "Insufficient balance!",
              });
              response.end();
            }
          );
          return;
        }

        // Take a payment id now rather than after a successful send: two
        // concurrent payments used to build their request with the same `txid`
        // and only bump the counter on success, so they collided.
        var paymentId = txid++;
        console.log("Next txid", txid);

        var paymentRequestForm = {
          id: paymentId.toString(),
          amount: amount,
          asset_code: USD,
          asset_issuer: ISSUER,
          destination: request.body.receiver,
          sender: friendlyid,
          use_compliance: true,
        };
        console.log("paymentRequestForm:", paymentRequestForm);

        // The money never left. Put the reservation back, then answer the caller.
        function refundAndFail(reason, body) {
          console.error("ERROR!", reason);
          pool.query(
            "UPDATE users SET balance = balance + $1 WHERE friendlyid = $2", [amount, ID],
            (refundError) => {
              if (refundError) {
                // The debit stuck, the send failed, and the refund failed too:
                // the balance is now short by `amount` with nothing to show
                // for it. Nothing here can fix that, so say so loudly rather
                // than let it look like an ordinary failed request.
                console.error(
                  "CRITICAL: failed to refund reserved funds after a failed payment.",
                  "account:", ID, "amount:", amount, "txid:", paymentId,
                  refundError
                );
              }
              response.json({
                result: body,
                msg: "ERROR!",
                error_msg: reason,
              });
              response.end();
            }
          );
        }

        postForm(config.entryPointBS, paymentRequestForm)
          .then(function (bridge) {
            if (bridge.status !== 200) {
              // The bridge answered, and it said no. The payment did not happen.
              refundAndFail("bridge responded " + bridge.status, bridge.body);
              return;
            }

            console.log("SUCCESS!", bridge.body);
            response.json({
              result: bridge.body,
              msg: "SUCCESS!",
            });
            response.end();
          })
          .catch(function (error) {
            // The call never completed at all -- the bridge host is down, DNS
            // failed. For the sender's balance this is the same as an outright
            // rejection: money must not stay debited for a payment that never
            // left. (`request` reported this as an `err` argument; a rejected
            // promise is the same event by another name.)
            refundAndFail(error && error.message ? error.message : String(error), undefined);
          });
      }
    );
  });

  app.get("/bankuser", requireAuth, function (request, response) {
    console.log("/bankuser:");
    pool.query("SELECT * from transactions", (error, results) => {
      if (error) {
        console.error(error);
        response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
        return;
      }

      if (results) {
        console.log("query response rowCount:", results.rowCount);
        if (results) {
          var answer = {tx: results.rows,};
          console.log("query response rows:", answer);
          response.json(answer);
          response.end();
        }
        else{
          response.end();
        }
      }
      else {
        console.log("ERROR KYC details");
      }
    });
  });

  return { app, server, pool };
}

// POSTs `form` to `url` as application/x-www-form-urlencoded -- the shape the
// bridge server expects, and the one `request.post({form})` used to produce.
//
// This is the whole reason the deprecated `request` package was still a
// dependency. It has been unmaintained since 2020 and pins a `tough-cookie`
// with a prototype-pollution CVE (CVE-2023-26136), which the bridge call has no
// use for -- it never touches a cookie. `node-fetch` was already a dependency
// (CallbacksA/B use it), so this removes a package and its vulnerable
// dependency tree rather than trading one for another.
//
// Resolves for any completed call, carrying the status; rejects only when the
// call never completed (host down, DNS failure). The caller must tell those two
// apart: both refund, but only one of them is the bridge saying no.
//
// The status is handed back raw rather than as fetch's `ok` (which is any 2xx),
// because the caller's rule is `!== 200` exactly, as it was under `request`.
// Widening that to 2xx would change which bridge replies trigger a refund, and
// a refund for a payment the bridge actually accepted is money created.
function postForm(url, form) {
  var body = new URLSearchParams();
  Object.keys(form).forEach(function (key) {
    body.append(key, String(form[key]));
  });

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }).then(function (bridgeResponse) {
    return bridgeResponse.text().then(function (text) {
      return {
        status: bridgeResponse.status,
        body: text,
      };
    });
  });
}

module.exports = { createDbServer, USD, ISSUER };
