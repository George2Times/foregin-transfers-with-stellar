// Bank B's bank-facing API. The handlers live in dbserver.js, which both banks
// share; this file is only the bits that are actually different about bank B.

const { createDbServer } = require("./dbserver");

createDbServer({
  listened_port: 3602,
  domain: "*bankb.com",
  conString: "postgres://bankbuser:password1@localhost:5432/bankb",
  entryPointBS: "http://localhost:8007/payment",
  firstTxid: 2000,
});
