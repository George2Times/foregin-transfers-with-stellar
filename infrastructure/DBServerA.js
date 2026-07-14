const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const requestObj = require("request");
const pg = require("pg");
const { parseAmount } = require("./money");

// ==== Config ====
var listened_port = 3600;
var domain = "*banka.com";
const conString = "postgres://bankauser:password1@localhost:5432/banka";
const USD = "USD";
const issuer = "GAIHBCB57M2SDFQYUMANDBHW4YYMD3FJVK2OGHRKKCNF2HBZIRBKRX6E";
var entryPointBS = "http://localhost:8006/payment";
var txid = 1000;

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

app.post("/userdet", function (request, response) {
  console.log("/userdet: ");
  if(!request.body.friendlyid) {
    // Previously this logged and returned without sending anything, leaving
    // the caller's request hanging until its own timeout. Every path through
    // a route handler has to end in a response.
    console.log("request.body.friendlyid:", request.body.friendlyid);
    response.status(400).json({ msg: "ERROR!", error_msg: "Missing friendlyid" });
  } else {
    var IdParts = request.body.friendlyid.split("*");
    var ID = IdParts[0];
    
    console.log("friendlyid:", request.body.friendlyid);
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

app.post("/userbal", function (request, response) {
  console.log("/userbal: ");
  if(!request.body.friendlyid) {
    // Same silent hang as /userdet: respond instead of falling off the end.
    console.log("request.body.friendlyid:", request.body.friendlyid);
    response.status(400).json({ msg: "ERROR!", error_msg: "Missing friendlyid" });
  } else {
    var IdParts = request.body.friendlyid.split("*");
    var ID = IdParts[0];
    
    console.log("friendlyid:", request.body.friendlyid);
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

app.post("/payment", function (request, response) {
  console.log("/payment: ");

  // Every one of these used to fall off the end of the handler with no
  // response at all, hanging the caller until its own timeout.
  if (!request.body.account) {
    console.log("request.body.account:", request.body.account);
    response.status(400).json({ msg: "ERROR!", error_msg: "Missing account" });
    return;
  }
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

  {
    var IdParts = request.body.account.split("*");
    var ID = IdParts[0];
    var friendlyid = ID + domain;
    console.log("friendlyid:", friendlyid);
    console.log("ID:", ID);
    console.log("amount:", amount);

    client.query(
      "SELECT balance from users where friendlyid = $1", [ID],
      (error, results) => {
        if (error) {
          response.json({
            msg: "ERROR!",
            error_msg: error,
          });
          response.end();
          return;
        }
        console.log("query response rowCount:", results.rowCount);
        if (results.rowCount === 0) {
          // Also a silent hang before: an unknown account got no response.
          console.log("no such account:", ID);
          response.status(404).json({ msg: "ERROR!", error_msg: "Account not found" });
          return;
        }
        {
          balance = results.rows[0].balance;
          console.log("query response balance:", balance);
          if (Number(balance) < amount) {
            response.json({
              msg: "ERROR!",
              error_msg: "Insufficient balance!",
            });
            response.end();
            return;
          }
          var paymentRequestForm = {
            id: txid.toString(),
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
                console.error("ERROR!", err || body);
                response.json({
                  result: body,
                  msg: "ERROR!",
                  error_msg: err,
                });
                response.end();
              } else {
                console.log("SUCCESS!", body);
                client.query(
                  "SELECT balance from users where friendlyid = $1", [ID],
                  (error, results) => {
                    if (error) {
                      console.log(error);
                      response.status(500).end("User Not found");
                    }
                    if (results) {
                      var balance = Number(results.rows[0].balance);
                      balance = balance - amount;
                      console.log("update ID, balance:", ID, ",", balance);
                      client.query(
                        "UPDATE users set balance = $1 where friendlyid = $2", [balance, ID],
                        (error, results) => {
                          if (error) {
                            console.log(error);
                            response.status(500).end("User Not found");
                          }
                          if (results) {
                            response.json({
                              result: body,
                              msg: "SUCCESS!",
                            });
                            txid++;
                            console.log("Next txid", txid);
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
        }
      }
    );
  }
});

app.get("/bankuser", function (request, response) {
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
