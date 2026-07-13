# foregin-transfers-with-stellar — backlog

**Status:** attention · **Path:** `C:\Users\George\Documents\Projekty\foregin-transfers-with-stellar`

## Must-have
- Compliance/sanctions screening is a no-op: `/compliance/sanctions` and `/compliance/ask_user`
  in `CallbacksA.js`/`CallbacksB.js` respond `200` (approved) regardless of what the sanction
  lookup actually returns — the real check in `/compliance/ask_user` is written but commented
  out. No transaction can ever be blocked by this gate as currently written.
- `/receive` has no idempotency check for duplicate payment notifications, despite a code
  comment saying one is required — a retried webhook double-credits a balance with no lookup
  against already-seen transaction ids.
- `/receive` truncates the fractional (cents) portion of every credited payment
  (`parseInt(Number(amount).toFixed(2))`), while the sending side deducts the full amount —
  a $12.75 transfer debits the sender $12.75 but credits the receiver only $12. Money is lost
  on every non-whole-dollar transfer.
- `/payment` performs no validation that `amount` is a positive number. A negative amount
  bypasses the balance check and *increases* the sender's stored balance instead of decreasing
  it; a non-numeric amount corrupts the balance to `NaN`. No client-side validation catches
  this either.
- Balance updates in `/payment` and `/receive` are non-atomic read-then-write sequences with
  no transaction or row locking — concurrent requests on the same account can race, permitting
  a spend beyond the actual balance (classic TOCTOU/lost-update).
- `/payment` (and `/userdet`/`/userbal`) silently hang with no HTTP response when a required
  field is missing or the account isn't found — the caller's request never resolves. This is
  the same bug class `HARDENING.md`'s fix #4 addressed for `/userdet`/`/userbal`, but the fix
  was never applied to `/payment` itself, and no test covers that path.
- No authentication anywhere in the payment flow — a free-text "Friendly ID" with no password
  is sufficient to view another user's balance or drain their account via `/userdet`,
  `/userbal`, and `/payment`. CORS is also wide open (`Access-Control-Allow-Origin: *`), so any
  website can invoke these endpoints from a victim's browser.
- `HARDENING.md` overstates its own `/payment` test coverage — it claims both `DBServerA.js`
  and `DBServerB.js` got tests for "insufficient balance, DB error, and the happy path," but
  `DBServerB.js`'s `/payment` handler only has the insufficient-balance case actually tested
  (confirmed by running `npm test`: DBServerA gets 3 sub-tests, DBServerB gets 1).

## Nice-to-have
- The pervasive `.then(function(response, error) {...})` pattern (front end and Stellar
  scripts) never actually catches promise rejections — `.then()`'s single callback only ever
  receives the resolved value, so `error` is always `undefined` and network failures fail
  silently with no user feedback.
- Nested pg-query error callbacks in `/payment`/`/receive` omit `return` after sending an
  error response, leaving them fragile to a future "headers already sent" crash if the
  fall-through code path ever stops being harmless by coincidence.
- `request@2.88.2` (used for the bridge-server HTTP call) is deprecated/unmaintained and pulls
  in a `tough-cookie` version with a known prototype-pollution CVE (CVE-2023-26136).
- Each server holds a single non-pooled `pg.Client` with no reconnect logic — a dropped DB
  connection permanently breaks the process until manual restart, since nothing ever
  reconnects after the initial `client.connect()`.
- `DBServerA.js`/`DBServerB.js` and `CallbacksA.js`/`CallbacksB.js` are near-byte-for-byte
  duplicates (differing only in a few config constants) — every fix, including several in
  `HARDENING.md`, has to be hand-applied twice, with the ever-present risk of only patching
  one side.
- The React front ends' actual payment/account logic (`App.js`'s `setAccount`/`payment`/
  `setBank`/`setBalance`) has zero test coverage — the existing tests only cover two small
  presentational components, not the code that drives money movement.

## Reference
- 2021-era demo wiring two toy banks together for cross-border payments over Stellar's old
  bridge/compliance/federation server stack: Postgres-backed Express APIs (`DBServerA/B.js`,
  `CallbacksA/B.js`), vendored compiled Stellar binaries, Create React App front ends
  (`pageA`/`pageB`), and standalone Stellar SDK scripts.
- Frozen, no CI, no active use — but the payment-endpoint logic is genuine hand-written code
  with real bug classes, not vendored/generated content, so it earns a real audit despite the
  project being dormant.
- A prior hardening pass (`HARDENING.md`, commit `8aa384b5`) already fixed the most severe
  issues found at the time (a `/payment` balance-check fallthrough, several crash-on-DB-error
  paths, missing 404s, committed `node_modules`/build bloat) and explicitly deferred a punch
  list (hardcoded local Postgres creds, a dead hardcoded IP, dev TLS certs, the vendored
  binaries, an unused `my-app` CRA scaffold) — this audit's findings are additional to, not a
  repeat of, that list.
