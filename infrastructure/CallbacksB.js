const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const fetch = require("node-fetch");
const pg = require("pg");
const { parseAmount } = require("./money");

// ==== Config ====
var listened_port = 5100;
const conString = "postgres://bankbuser:password1@localhost:5432/bankb";
var domain = "*bankb.com";

// A pool, not a single Client: /receive runs a real BEGIN/COMMIT transaction,
// and a transaction needs a connection to itself. On one shared Client, every
// request's queries interleave on the same connection, so one request's BEGIN
// would wrap another request's queries. A pool hands each transaction its own
// connection. (One-off queries below still go through pool.query(), which
// borrows and returns a connection per call.)
const pool = new pg.Pool({ connectionString: conString });
pool.on("error", function (error) {
  // An idle client erroring out (e.g. the DB restarted) must not take the
  // process down; the pool discards it and reconnects on the next query.
  console.error("postgres pool error:", error);
});
app.use(bodyParser.json());
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

app.use(function (req, res, next) {
  // Website you wish to allow to connect
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Request methods you wish to allow
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, PATCH, DELETE"
  );

  // Request headers you wish to allow
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Requested-With,content-type"
  );

  // Set to true if you need the website to include cookies in the requests sent
  // to the API (e.g. in case you use sessions)
  res.setHeader("Access-Control-Allow-Credentials", true);

  // Pass to next layer of middleware
  next();
});

var server = app.listen(process.env.PORT || listened_port, function () {
  var port = server.address().port;
  console.log("App now running on port", port);
});

app.post("/compliance/fetch_info", function (request, response) {
  console.log("/compliance/fetch_info");
  console.log("request.body.address:", request.body.address);
  var addressParts = request.body.address.split("*");
  var friendlyId = addressParts[0];
  console.log("friendlyId:", friendlyId);
  // You need to create `accountDatabase.findByFriendlyId()`. It should look
  // up a customer by their Stellar account and return account information.

  pool.query(
    "SELECT name,address,dob,domain FROM users WHERE friendlyid = $1", [friendlyId],
    (error, results) => {
      if (error) {
        console.error(error);
        response.status(500).json({ msg: "ERROR!", error_msg: "Database error" });
        return;
      }
      if (results.rowCount != 0) {
        var answer = {
          name: results.rows[0].name,
          address: results.rows[0].address,
          date_of_birth: results.rows[0].dob.toString(),
          domain: results.rows[0].domain,
        };
        console.log("query answer:", answer);
        response.json(answer);
      }
      response.end();
    }
  );
});

// Screens the sending financial institution against the `sanction` table and
// responds 200 (approved) / 403 (denied) per the Stellar compliance protocol.
//
// The `sanction` column is an "is this FI sanctioned/permitted to transact with
// us" flag: only `true` approves. Anything else -- an FI that is flagged false,
// an FI with no row at all, or a lookup we could not perform -- denies, so the
// gate fails closed. Every non-200 here blocks the payment at the bridge.
function screenSender(label, request, response) {
  console.log(label);

  var sender;
  try {
    sender = JSON.parse(request.body.sender);
  } catch (parseError) {
    console.error(label, "unparseable sender:", parseError.message);
    response.status(400).end("Malformed sender");
    return;
  }
  if (!sender || !sender.domain) {
    console.error(label, "sender has no domain");
    response.status(400).end("Missing sender domain");
    return;
  }
  console.log("sender.domain:", sender.domain);

  pool.query(
    "SELECT domain,bankname,sanction FROM sanction WHERE domain = $1", [sender.domain],
    (error, results) => {
      if (error) {
        // A screening we could not perform is not a screening that passed.
        console.error(label, "sanction lookup failed:", error);
        response.status(500).end("Compliance check failed");
        return;
      }
      console.log("query response rowCount:", results.rowCount);
      if (results.rowCount === 0) {
        console.log(label, "unknown FI, denied, status code", 403);
        response.status(403).end("Unknown financial institution");
        return;
      }
      var row = results.rows[0];
      console.log("query answer:", {
        domain: row.domain,
        bankname: row.bankname,
        sanction: row.sanction,
      });
      if (row.sanction !== true) {
        console.log(label, "denied, status code", 403);
        response.status(403).end("Sender denied by sanctions screening");
        return;
      }
      console.log(label, "approved, status code", 200);
      response.status(200).end();
    }
  );
}

app.post("/compliance/sanctions", function (request, response) {
  screenSender("/compliance/sanctions", request, response);
});

app.post("/compliance/ask_user", function (request, response) {
  screenSender("/compliance/ask_user", request, response);
});

app.post("/receive", async function (request, response) {
  console.log("/receive");
  // The credited amount must be the amount the sender was debited, to the cent.
  // This used to be parseInt(Number(amount).toFixed(2)), which threw away the
  // fractional part of every payment: a $12.75 transfer debited the sender
  // $12.75 and credited the receiver $12.00, destroying $0.75 in transit.
  var amount = parseAmount(request.body.amount);
  var friendlyid = request.body.route;
  var txId = request.body.transaction_id;
  console.log("amount", amount);
  console.log("friendlyid", friendlyid);
  console.log("transaction_id", txId);

  if (amount === null) {
    console.error("/receive: invalid amount:", request.body.amount);
    response.status(400).end("Invalid amount");
    return;
  }
  if (!friendlyid) {
    console.error("/receive: missing route");
    response.status(400).end("Missing route");
    return;
  }
  if (!txId) {
    // Without a payment id we cannot tell a retry from a new payment, and
    // crediting an unidentifiable payment is how you double-credit one.
    console.error("/receive: missing transaction_id");
    response.status(400).end("Missing transaction_id");
    return;
  }

  var SendObj;
  var kycObj;
  try {
    SendObj = JSON.parse(request.body.data);
    kycObj = JSON.parse(SendObj.attachment);
  } catch (parseError) {
    console.error("/receive: unparseable payload:", parseError.message);
    response.status(400).end("Malformed payment payload");
    return;
  }

  // The bridge may deliver the same payment more than once (that's what the
  // original "check that you haven't already seen this payment ID" comment was
  // asking for, and it was never written). Recording the payment and crediting
  // the balance therefore have to be one atomic, idempotent unit:
  //
  //  - FOR UPDATE locks the receiving account row, so two concurrent deliveries
  //    of the same payment serialize here instead of both passing the duplicate
  //    check and both crediting.
  //  - The credit is `balance = balance + $1`, computed by the database, not a
  //    read-then-write of a balance we read earlier -- so a concurrent /receive
  //    or /payment on the same account can't be lost.
  //  - Everything commits together, or nothing does: we can no longer record a
  //    transaction we didn't credit, or credit one we didn't record.
  var db = await pool.connect();
  try {
    await db.query("BEGIN");

    var account = await db.query(
      "SELECT friendlyid FROM users WHERE friendlyid = $1 FOR UPDATE", [friendlyid]
    );
    if (account.rowCount === 0) {
      await db.query("ROLLBACK");
      console.error("/receive: unknown receiver:", friendlyid);
      response.status(404).end("Unknown receiver");
      return;
    }

    var seen = await db.query("SELECT 1 FROM transactions WHERE txid = $1", [txId]);
    if (seen.rowCount !== 0) {
      await db.query("ROLLBACK");
      // Already credited. Answer 200 so the bridge stops retrying -- this is a
      // successful delivery of a payment we have already handled, not an error.
      console.log("/receive: duplicate delivery of", txId, "- already credited");
      response.status(200).end();
      return;
    }

    await db.query(
      "INSERT INTO transactions(txid,sender,receiver,amount,currency,kyc_info) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        txId,
        SendObj.sender,
        friendlyid,
        amount,
        request.body.asset_code,
        kycObj.transaction.sender_info,
      ]
    );

    await db.query(
      "UPDATE users SET balance = balance + $1 WHERE friendlyid = $2", [amount, friendlyid]
    );

    await db.query("COMMIT");
    console.log("/receive: credited", amount, "to", friendlyid, "for", txId);
    response.status(200).end();
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("/receive: rollback failed:", rollbackError.message);
    }

    // A unique-constraint violation on transactions.txid means a concurrent
    // delivery of this same payment committed first. It is credited exactly
    // once, which is the point -- so this is a success, not a failure.
    // (Requires the UNIQUE constraint on transactions.txid; see FLEET_NOTES.md.)
    if (error && error.code === "23505") {
      console.log("/receive: concurrent duplicate of", txId, "- already credited");
      response.status(200).end();
      return;
    }

    console.error("/receive: failed to credit", txId, error);
    response.status(500).end("Error recording payment");
  } finally {
    db.release();
  }
});

/*})})*/

app.post("/test", function (request, response) {
  fetch("http://banka.com/.well-known/stellar.toml")
    .then(function (response, error) {
      if (response) {
        console.log("response", response);
        return response.text();
      }
    })
    .then(function (data) {
      console.log("data", data);

      response.json({
        data: data,
      });
      response.end();
    });
});
