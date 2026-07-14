// Bank B's bridge-facing callbacks. The handlers live in callbacks.js, which
// both banks share; this file is only what is different about bank B.

const { createCallbacks } = require("./callbacks");

createCallbacks({
  listened_port: 5100,
  conString: "postgres://bankbuser:password1@localhost:5432/bankb",
});
