# foregin-transfers-with-stellar — backlog

**Status:** attention · **Path:** `C:\Users\George\Documents\Projekty\foregin-transfers-with-stellar`

## Must-have

All eight must-haves were addressed in the 2026-07-14 pass (branch
`hardening-pass-2026-07-12`). Test count went from 6 to 103, all passing
offline (`npm test` in `infrastructure/`). Two items need a human with database
access to finish the job — see `FLEET_NOTES.md`.

- ~~Compliance/sanctions screening is a no-op: `/compliance/sanctions` and `/compliance/ask_user`
  in `CallbacksA.js`/`CallbacksB.js` respond `200` (approved) regardless of what the sanction
  lookup actually returns — the real check in `/compliance/ask_user` is written but commented
  out. No transaction can ever be blocked by this gate as currently written.~~
  **Fixed** (`9a1ef78d`). Both routes now share one `screenSender()` that approves only on an
  explicit `sanction = true` row and otherwise fails closed: an FI flagged `false` → 403, an FI
  with no row → 403, a lookup that errored → 500 (previously this branch fell through to the
  200), a malformed sender → 400 (previously an uncaught `JSON.parse` throw). Approval semantics
  taken from the commented-out check that was already there. 22 tests; all the "denies" cases
  fail against the pre-fix source.

- ~~`/receive` has no idempotency check for duplicate payment notifications, despite a code
  comment saying one is required — a retried webhook double-credits a balance with no lookup
  against already-seen transaction ids.~~
  **Fixed** (`f2599886`). `/receive` now looks up `transaction_id` before crediting and answers
  200 to a duplicate (a retry of a payment we already handled is a success, and 200 is what stops
  the bridge retrying). Sound against concurrent deliveries because the receiving account row is
  locked `FOR UPDATE` first. A `UNIQUE` constraint on `transactions.txid` would make it airtight
  across the board — the code already handles the resulting `23505` — but adding it needs a
  database I can't reach: **written up in `FLEET_NOTES.md` §1.**

- ~~`/receive` truncates the fractional (cents) portion of every credited payment
  (`parseInt(Number(amount).toFixed(2))`), while the sending side deducts the full amount —
  a $12.75 transfer debits the sender $12.75 but credits the receiver only $12. Money is lost
  on every non-whole-dollar transfer.~~
  **Fixed** (`0fe366d9`). Both sides now parse amounts through one shared `money.js#parseAmount`,
  so the sending and receiving definitions of "a valid amount" cannot drift apart — when they
  disagree, the difference is money created or destroyed in transit. Rounds in integer cents
  (`1.005 * 100` is `100.49999999999999` in floating point, so a bare `Math.round` rounds a
  half-cent down).

- ~~`/payment` performs no validation that `amount` is a positive number. A negative amount
  bypasses the balance check and *increases* the sender's stored balance instead of decreasing
  it; a non-numeric amount corrupts the balance to `NaN`. No client-side validation catches
  this either.~~
  **Fixed** (`0377acba`). `/payment` rejects anything that isn't a positive finite amount, before
  touching the database or the bridge; both front ends validate before submitting too. Also fixed
  in the same commit: `/payment` (and the missing-field path of `/userdet`/`/userbal`) used to
  send **no HTTP response at all** and hang the caller — see the next-but-one item.

- ~~Balance updates in `/payment` and `/receive` are non-atomic read-then-write sequences with
  no transaction or row locking — concurrent requests on the same account can race, permitting
  a spend beyond the actual balance (classic TOCTOU/lost-update).~~
  **Fixed** (`ef17cee5` for `/payment`, `f2599886` for `/receive`). `/payment` now reserves funds
  with a single conditional statement (`UPDATE ... SET balance = balance - $1 WHERE friendlyid =
  $2 AND balance >= $1`) *before* calling the bridge, and refunds if the bridge fails; the check
  and the debit can no longer be separated, and nothing is sent until the money is provably set
  aside. `/receive` runs `BEGIN` / `SELECT ... FOR UPDATE` / `INSERT` / `UPDATE ... balance =
  balance + $1` / `COMMIT` as one unit. The callbacks moved from a single shared `pg.Client` to a
  `pg.Pool`, because a transaction needs a connection to itself — on one shared client, one
  request's `BEGIN` wraps another request's queries.

- ~~`/payment` (and `/userdet`/`/userbal`) silently hang with no HTTP response when a required
  field is missing or the account isn't found — the caller's request never resolves. This is
  the same bug class `HARDENING.md`'s fix #4 addressed for `/userdet`/`/userbal`, but the fix
  was never applied to `/payment` itself, and no test covers that path.~~
  **Fixed** (`0377acba`). Every path through these handlers now ends in a response: 400 on a
  missing/invalid field, 404 on an unknown account. The test harness now *fails* a case that
  never responds instead of hanging the run, so this bug class can't come back unnoticed —
  against the pre-fix source those cases fail on exactly that timeout.

- ~~No authentication anywhere in the payment flow — a free-text "Friendly ID" with no password
  is sufficient to view another user's balance or drain their account via `/userdet`,
  `/userbal`, and `/payment`. CORS is also wide open (`Access-Control-Allow-Origin: *`), so any
  website can invoke these endpoints from a victim's browser.~~
  **Fixed in code** (`29c50c9c`), **but needs a human to finish** — see `FLEET_NOTES.md` §2/§3.
  New `infrastructure/auth.js` (no new dependencies; scrypt + HMAC from `node:crypto`): `POST
  /login` trades a friendly ID + password for a signed bearer token, and `requireAuth` guards
  `/userdet`, `/userbal`, `/payment`, `/bankuser`. The part that actually closes the hole is that
  those routes now take the account **from the verified token and ignore the body** — a caller
  can no longer act on an account it hasn't authenticated as. CORS is an allow-list
  (`ALLOWED_ORIGINS`) instead of `*`. Front ends grew a password field and send the token.
  **Not runnable until a human does two things I can't:** set `SESSION_SECRET` (the servers refuse
  to start without it, deliberately — a default signing key in a repo is no better than no auth),
  and add a `users.password_hash` column with at least one seeded password. Migration SQL and
  commands are in `FLEET_NOTES.md`.

- ~~`HARDENING.md` overstates its own `/payment` test coverage — it claims both `DBServerA.js`
  and `DBServerB.js` got tests for "insufficient balance, DB error, and the happy path," but
  `DBServerB.js`'s `/payment` handler only has the insufficient-balance case actually tested
  (confirmed by running `npm test`: DBServerA gets 3 sub-tests, DBServerB gets 1).~~
  **Fixed** (`5170ba66`). Confirmed the report was right: A had 3 sub-tests, B had 1. Rather than
  just softening the sentence, the claim was made true — the `/payment` suite is now written once
  and run against both servers (13 sub-tests each, 26 total). `HARDENING.md` carries a dated
  correction saying what it originally got wrong and why (the *fix* had been applied to both
  files; only the *tests* were lopsided). Every suite added in this pass runs against both copies
  for the same reason: testing one and eyeballing the other is how a fix ends up half-applied.

## Nice-to-have

Mostly not touched in the 2026-07-14 pass (out of scope — must-haves only). The two items
below were finished in the 2026-07-14 follow-up pass; the rest are still open.

- ~~The pervasive `.then(function(response, error) {...})` pattern (front end and Stellar
  scripts) never actually catches promise rejections — `.then()`'s single callback only ever
  receives the resolved value, so `error` is always `undefined` and network failures fail
  silently with no user feedback.~~
  **Fixed** (`8fc5e125` for `stellar/`, `0fbc824d` for the servers). The `App.js` front ends had
  already been rewritten with real `.catch()` handlers by the auth work. This pass cleared the
  remaining sites, and found a third the item hadn't named:
  - `stellar/TransferUSD.js` — the broken shape itself, plus no `.catch` anywhere and the inner
    chain never returned to the outer callback, so a rejection had *no* handler attached. Fixed
    in the live block and in both commented-out transfer variants: the file's idiom is to
    comment-toggle which transfer runs, so a dormant copy of the bug is a live one in waiting.
  - `stellar/CreateAssetUSD.js` — had a `.catch`, but the inner `loadAccount(...)` chain was
    started and dropped rather than returned, so the catch only ever covered `fetchBaseFee`, not
    the two calls that actually touch the network. Same class, quieter about it.
  - **`/test` in `CallbacksA/B.js`** — the same shape, inside a payment server, and the worst of
    the three: no `.catch` meant a rejected fetch sent *no HTTP response at all* and hung the
    caller (the never-responds class the must-haves fixed in `/payment`), and `if (response)` was
    true for a 404, so a failed lookup was reported to the caller as a success carrying no toml.
    Now 200 with the body, or 502. 8 new sub-tests across both copies; 103 → 113, all passing.
    The three error-path cases fail against the pre-fix source.
  Both scripts now also exit non-zero on failure, so a failed run is visible to whatever ran them.
  **Still open, deliberately:** `stellar/federationAtest.js` and `stellar/test_FSA.js` ignore the
  `error` argument of their `request` callbacks and log an `undefined` body on failure. That is
  the same *silent network failure* complaint, but it is a different mechanism — those callbacks
  do receive a real error; nobody reads it — so it is left for a pass that scopes it.
- ~~Nested pg-query error callbacks in `/payment`/`/receive` omit `return` after sending an
  error response, leaving them fragile to a future "headers already sent" crash if the
  fall-through code path ever stops being harmless by coincidence.~~
  **Overtaken, verified, no code change.** Re-read both handlers against this item rather than
  trusting the earlier annotation: `/receive` is now one `async`/`await` block whose every error
  branch returns (including the `23505` duplicate path), and `/payment`'s callbacks all `return`
  after responding. There is no remaining fall-through to harden, so this item is closed as
  already-fixed by the must-have rewrites rather than by new work.
- `request@2.88.2` (used for the bridge-server HTTP call) is deprecated/unmaintained and pulls
  in a `tough-cookie` version with a known prototype-pollution CVE (CVE-2023-26136).
- Each server holds a single non-pooled `pg.Client` with no reconnect logic — a dropped DB
  connection permanently breaks the process until manual restart, since nothing ever
  reconnects after the initial `client.connect()`.
  *(Half-done: `CallbacksA/B` now use a `pg.Pool`, which reconnects, because `/receive`'s
  transaction required it. `DBServerA/B` still hold a single `pg.Client`.)*
- `DBServerA.js`/`DBServerB.js` and `CallbacksA.js`/`CallbacksB.js` are near-byte-for-byte
  duplicates (differing only in a few config constants) — every fix, including several in
  `HARDENING.md`, has to be hand-applied twice, with the ever-present risk of only patching
  one side.
  *(Still true, and it bit again: every must-have above had to be applied twice. Mitigated for
  now by regenerating the `B` file from the `A` file so the two provably differ only in their
  config constants, and by running every test suite against both copies. The real fix — extracting
  the shared handlers into one module the two files configure — is still worth doing.)*
- The React front ends' actual payment/account logic (`App.js`'s `setAccount`/`payment`/
  `setBank`/`setBalance`) has zero test coverage — the existing tests only cover two small
  presentational components, not the code that drives money movement.
  *(Still true. `App.js` was changed substantially by the auth work and is still untested; the
  server-side equivalents of that logic now are.)*

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
- No live network, blockchain, or database call was made in the 2026-07-14 pass or its follow-up.
  All 113 tests (103 from the must-have pass, 10 more from the follow-up's `/test` route suite)
  run offline against hand-written `pg`/`express`/`request`/`node-fetch` fakes that load the real
  server files, so the route handlers under test are the committed ones, not re-implementations.
- The Stellar scripts under `stellar/` have no tests: they are thin CLI wrappers whose every
  branch is a call to a live Stellar network, so the promise-error fixes there were reviewed and
  syntax-checked but not driven end-to-end. The equivalent fix in `CallbacksA/B`'s `/test` route
  *is* covered, because that one can be faked offline.
- `react-scripts build` fails in both front ends on Node 26 (`ERR_PACKAGE_PATH_NOT_EXPORTED` from
  a nested `postcss`). Pre-existing — it fails identically on the untouched 2021 code — and not
  something this pass tried to fix. The apps' Jest tests do still run and pass.
