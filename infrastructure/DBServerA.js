// Bank A's bank-facing API. The handlers live in dbserver.js, which both banks
// share; this file is only the bits that are actually different about bank A.

const { createDbServer } = require("./dbserver");

createDbServer({
  listened_port: 3600,
  domain: "*banka.com",
  conString: "postgres://bankauser:password1@localhost:5432/banka",
  entryPointBS: "http://localhost:8006/payment",
  firstTxid: 1000,
});
