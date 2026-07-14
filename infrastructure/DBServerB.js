const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const requestObj = require("request");
const pg = require("pg");
const { parseAmount } = require("./money");
const auth = require("./auth");

// ==== Config ====
var listened_port = 3602;
var domain = "*bankb.com";
const conString = "postgres://bankbuser:password1@localhost:5432/bankb";
const USD = "USD";
const issuer = "GAIHBCB57M2SDFQYUMANDBHW4YYMD3FJVK2OGHRKKCNF2HBZIRBKRX6E";
var entryPointBS = "http://localhost:8007/payment";
var txid = 2000;

const client = new pg.Client(conString);
client.connect();
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

var server = app.listen(process.env.PORT || listened_port, function () {
  var port = server.address().port;
  console.log("App now running on port", port);
});

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

  client.query(
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

    client.query(
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

    client.query(
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
            //client.end();
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
  client.query(
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
        client.query(
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
        asset_issuer: issuer,
        destination: request.body.receiver,
        sender: friendlyid,
        use_compliance: true,
      };
      console.log("paymentRequestForm:", paymentRequestForm);
      requestObj.post({
          url: entryPointBS,
          form: paymentRequestForm,
        },
        function (err, res, body) {
          if (err || res.statusCode !== 200) {
            // The money never left. Put the reservation back.
            console.error("ERROR!", err || body);
            client.query(
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
                  error_msg: err,
                });
                response.end();
              }
            );
            return;
          }

          console.log("SUCCESS!", body);
          response.json({
            result: body,
            msg: "SUCCESS!",
          });
          response.end();
        }
      );
    }
  );
});

app.get("/bankuser", requireAuth, function (request, response) {
  console.log("/bankuser:");
  client.query("SELECT * from transactions", (error, results) => {
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
