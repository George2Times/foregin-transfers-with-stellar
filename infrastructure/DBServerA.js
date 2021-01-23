const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const requestObj = require("request");
const pg = require("pg");

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
    console.log("request.body.friendlyid:", request.body.friendlyid);
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
          throw error;
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
        }
      }
    );
  }
});

app.post("/userbal", function (request, response) {
  console.log("/userbal: ");
  if(!request.body.friendlyid) {
    console.log("request.body.friendlyid:", request.body.friendlyid);
  } else {
    var IdParts = request.body.friendlyid.split("*");
    var ID = IdParts[0];
    
    console.log("friendlyid:", request.body.friendlyid);
    console.log("ID:", ID);

    client.query(
      "SELECT balance FROM users WHERE friendlyid = $1", [ID],
      (error, results) => {
        if (error) {
          throw error;
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
          }
        }
      }
    );
  }
});

app.post("/payment", function (request, response) {
  console.log("/payment: ");
  if(!request.body.account) {
    console.log("request.body.account:", request.body.account);
  } else {
    var IdParts = request.body.account.split("*");
    var ID = IdParts[0];
    var friendlyid = ID + domain;
    console.log("friendlyid:", friendlyid);
    console.log("ID:", ID);

    client.query(
      "SELECT balance from users where friendlyid = $1", [ID],
      (error, results) => {
        if (error) {
          response.json({
            msg: "ERROR!",
            error_msg: error,
          });
          response.end();
        }
        console.log("query response rowCount:", results.rowCount);
        if (results.rowCount != 0) {
          balance = results.rows[0].balance;
          console.log("query response balance:", balance);
          if (balance < Number(request.body.amount)) {
            response.json({
              msg: "ERROR!",
              error_msg: "Insufficient balance!",
            });
            response.end();
          }
          var paymentRequestForm = {
            id: txid.toString(),
            amount: request.body.amount,
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
                      balance = balance + -request.body.amount;
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
      throw error;
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
