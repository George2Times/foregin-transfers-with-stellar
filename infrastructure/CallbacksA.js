// Bank A's bridge-facing callbacks. The handlers live in callbacks.js, which
// both banks share; this file is only what is different about bank A.

const { createCallbacks } = require("./callbacks");

createCallbacks({
  listened_port: 5000,
  conString: "postgres://bankauser:password1@localhost:5432/banka",
});
