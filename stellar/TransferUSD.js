const StellarSdk = require("stellar-sdk");

const server = new StellarSdk.Server("http://127.0.0.1:8000", {
  allowHttp: true,
});

var issuingKeys = StellarSdk.Keypair.fromSecret(
  "SAEEE4UUP3DRYTEFHNFKCVB4ZCQT2W2KPFW7FLE6VLE7QABAAZATFZFD"
);

var receivingKeys1 = StellarSdk.Keypair.fromSecret(
  "SDSQ5MJALF7VWDFEFETPGGWJK2UEQ5HU6HJBKMT5M5YDJ3WYKMC5RC3O"
);
var receivingKeys2 = StellarSdk.Keypair.fromSecret(
  "SB6HTLWBKVY6KOGKFZE2EKH3ZFSIYHYXJOORGKIOHSMPHBCX4SS4PU6G"
);

var USD = new StellarSdk.Asset(
  "USD",
  "GAIHBCB57M2SDFQYUMANDBHW4YYMD3FJVK2OGHRKKCNF2HBZIRBKRX6E"
);

// Transfer 1000 USD to receivingKeys1 (bank A)
// server
//   .fetchBaseFee()
//   .then(function (fee) {
//     console.log("Fee is", fee);
//     return server
//       .loadAccount(issuingKeys.publicKey())
//       .then(function (account) {
//         var transaction = new StellarSdk.TransactionBuilder(account, {
//           fee,
//           networkPassphrase: "Standalone Network ; February 2017",
//         })
//           .addOperation(
//             StellarSdk.Operation.payment({
//               destination: receivingKeys1.publicKey(),
//               asset: USD,
//               amount: "1000",
//             })
//           )
//           .setTimeout(100)
//           .build();

//         transaction.sign(issuingKeys);

//         return server.submitTransaction(transaction);
//       });
//   })
//   .then(function (response) {
//     console.log("Response", response);
//   })
//   .catch(function (error) {
//     console.error("Transfer failed:", error);
//     process.exitCode = 1;
//   });

// Transfer 2000 USD to receivingKeys1 (bank A)
//
// Two things this chain has to get right, both of which the original got wrong
// and which between them made a failed transfer look exactly like a successful
// one:
//   - `.then(fn)` calls `fn` with one argument, the resolved value. The old
//     `.then(function (response, error) {...})` therefore always saw `error`
//     as `undefined`, and its `else` branch -- the only place an error was
//     ever reported -- was unreachable. Rejections belong in `.catch`.
//   - The inner chain has to be *returned* to the outer callback. Without the
//     return, the outer promise settles as soon as `loadAccount` is started,
//     and a later rejection has no handler attached to it at all.
server
  .fetchBaseFee()
  .then(function (fee) {
    console.log("Fee is", fee);
    return server
      .loadAccount(issuingKeys.publicKey())
      .then(function (account) {
        var transaction = new StellarSdk.TransactionBuilder(account, {
          fee,
          networkPassphrase: "Standalone Network ; February 2017",
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: receivingKeys2.publicKey(),
              asset: USD,
              amount: "2000",
            })
          )
          .setTimeout(100)
          .build();

        transaction.sign(issuingKeys);

        return server.submitTransaction(transaction);
      });
  })
  .then(function (response) {
    console.log("Response", response);
  })
  .catch(function (error) {
    console.error("Transfer failed:", error);
    process.exitCode = 1;
  });

// NB: this variant also references GBP and EUR, which this file never defines --
// it needs those assets declared before it can be uncommented and run.
/*
server
  .fetchBaseFee()
  .then(function (fee) {
    console.log("Fee is", fee);
    return server
      .loadAccount(issuingKeys.publicKey())
      .then(function (account) {
        var transaction = new StellarSdk.TransactionBuilder(account, {
          fee,
          networkPassphrase: "Standalone Network ; February 2017",
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: receivingKeys2.publicKey(),
              asset: USD,
              amount: "1000000",
            })
          )
          .addOperation(
            StellarSdk.Operation.payment({
              destination: receivingKeys2.publicKey(),
              asset: GBP,
              amount: "1000000",
            })
          )
          .addOperation(
            StellarSdk.Operation.payment({
              destination: receivingKeys2.publicKey(),
              asset: EUR,
              amount: "1000000",
            })
          )
          .setTimeout(100)
          .build();

        transaction.sign(issuingKeys);

        return server.submitTransaction(transaction);
      });
  })
  .then(function (response) {
    console.log("Response", response);
  })
  .catch(function (error) {
    console.error("Transfer failed:", error);
    process.exitCode = 1;
  });
*/