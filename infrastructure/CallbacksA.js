const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const fetch = require("node-fetch");
const pg = require("pg");
const { parseAmount } = require("./money");

// ==== Config ====
var listened_port = 5000;
const conString = "postgres://bankauser:password1@localhost:5432/banka";
var domain = "*banka.com";

const client = new pg.Client(conString);
client.connect();
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

  client.query(
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

  client.query(
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

app.post("/receive", function (request, response) {
  console.log("/receive");
  // The credited amount must be the amount the sender was debited, to the cent.
  // This used to be parseInt(Number(amount).toFixed(2)), which threw away the
  // fractional part of every payment: a $12.75 transfer debited the sender
  // $12.75 and credited the receiver $12.00, destroying $0.75 in transit.
  var amount = parseAmount(request.body.amount);
  var friendlyid = request.body.route;
  console.log("amount", amount);
  console.log("friendlyid", friendlyid);

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
  // `receive` may be called multiple times for the same payment, so check that
  // you haven't already seen this payment ID.
  var SendObj = JSON.parse(request.body.data);
  var kycObj = JSON.parse(SendObj.attachment);
  client.query(
    "INSERT INTO transactions(txid,sender,receiver,amount,currency,kyc_info) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      request.body.transaction_id,
      SendObj.sender,
      request.body.route,
      amount,
      request.body.asset_code,
      kycObj.transaction.sender_info,
    ],
    (error, results) => {
      if (error) {
        console.log(error);
        response.status(500).end("Error inserting transaction");
      }
      if (results) {
        console.log("REached here", results);
        client.query(
          "SELECT balance FROM users WHERE friendlyid = $1", [friendlyid],
          (error, results) => {
            if (error) {
              console.log(error);
              response.status(500).end("Not found");
            }
            if (results) {
              console.log("results", results);
              var balance = Number(results.rows[0].balance);
              balance = balance + +amount;
              console.log("balance", balance);

              client.query(
                "UPDATE users SET balance = $1 WHERE friendlyid = $2", [balance, friendlyid],
                (error, results) => {
                  if (error) {
                    console.log(error);
                    response.status(500).end("Not found");
                  }
                  if (results) {
                    console.log(results);
                    response.status(200).end();
                  }
                }
              );
            }
          }
        );
      }
    }
  );
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
