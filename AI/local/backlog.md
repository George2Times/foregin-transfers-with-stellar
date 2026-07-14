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

All eight are now closed. The original six went in the 2026-07-14 passes; the two that a
targeted re-audit of `auth.js` added were done in the 2026-07-14 auth-hardening pass below.
Server tests 121 → 145, front ends 26 → 27 each, all passing.

- ~~No rate limiting or lockout on `/login` (`dbserver.js:78-117`) — a timing/enumeration
  or brute-force attempt against confirmed accounts can run at unlimited speed.~~
  **Fixed** (`528c9469`, plus `bb31daea` for the front ends). Everything else about the route
  was already careful — the 401 is worded identically whether the account is unknown, has no
  password, or the password is wrong, and scrypt makes each check deliberately slow — but none
  of that costs an attacker anything if they may simply keep trying. Two failure budgets, in
  separate tables: **5 failures locks the friendly ID** (stops a password list), **50 locks the
  source address** (stops the same attacker sidestepping the first budget by spraying one
  password across many accounts). Separate tables because an attacker who churns the per-account
  table with thousands of made-up IDs must still accumulate failures against their own source
  entry, in a table they cannot flood.
  Only a failed *password attempt* counts: a missing field doesn't (or anyone could lock any
  account out of its own bank by posting its ID with no password five times) and neither does a
  database error (or a wobbly database would lock out every customer it has). A success clears
  the account's count, so a typo followed by the right password leaves nothing behind. The check
  runs *before* the lookup and the hashing — unlimited `/login` was a way to spend this server's
  CPU as well as to guess at it. The lockout is keyed on the ID **as typed**, so an invented
  account locks out exactly like a real one; otherwise the lockout would answer the question the
  identical 401s exist to refuse.
  **The item's "timing" half was a real, separate hole, and is also fixed:** `verifyPassword()`
  returned false *immediately* when the row had no usable hash and spent ~100ms of scrypt when it
  did. The reply was identical; how long it took to arrive was not, and that is just as good an
  answer to "does alice bank here?" as an error message would be. It now checks against a
  throwaway hash and discards the result. Pinned by a timing test (~100ms vs ~0 before).
  19 new sub-tests; the four route cases and the timing one all fail against the pre-fix source.
  The front ends were showing a flat "Login failed" for a 429 — i.e. telling someone whose
  password is *correct* that it is wrong, so they retry, and each retry restarts the cooldown.
  They now show the server's reason.
  **Needs a human if this is ever deployed behind a proxy:** the per-source budget keys on
  `request.ip`, which Express only fills from `X-Forwarded-For` once `trust proxy` is set.
  Behind an untrusted-proxy setup the whole internet shares one budget and one attacker could
  lock out the entire bank. Written up in `FLEET_NOTES.md` §4, along with what the lockout
  deliberately isn't (in-memory, per-process: cleared by a restart, not shared between instances).
- ~~Tokens carry no per-bank audience binding (`auth.js`'s `issueToken` payload is only
  `{sub, exp}`). `FLEET_NOTES.md` already instructs a separate `SESSION_SECRET` per
  bank; nothing in the code enforces or detects a shared secret, so violating that
  documented instruction would let a token minted by one bank's `/login` also pass the
  other bank's `requireAuth`.~~
  **Fixed** (`0f63402c`). A token said only "this is alice, until 14:05" and not *which bank's*
  alice — and the two banks run the same code over separate databases in which "alice" is a
  different customer with different money. What kept them apart was a sentence in
  `FLEET_NOTES.md`, and a document is not an enforcement mechanism: paste the same secret into
  both (the obvious thing to do — it is one setting and they are one demo) and every token minted
  by A's `/login` was correctly signed, unexpired, and accepted by B's `requireAuth`. No forgery
  needed; A's alice could read B's alice's balance and spend her money.
  Tokens now carry `aud` and `requireAuth` refuses one naming the other bank. It's inside the
  signed payload, so a holder cannot re-point it. The value is the **federation domain** rather
  than a new config field, because that domain already has to be distinct for the two banks to
  tell each other's customers apart — a third bank cannot collide with an existing audience
  without also being unable to receive a payment. Both directions fail closed: `issueToken`
  refuses to mint an audience-less token rather than mint one good everywhere, `verifyToken`
  refuses to check against no audience rather than accept all comers, and a token predating the
  change has no `aud` and is dead (they last an hour, so that costs one re-login).
  This does **not** make a shared `SESSION_SECRET` safe — each bank can still *mint* tokens the
  other will honour — it means an operator who ignores the instruction no longer silently merges
  the two banks' customers. `FLEET_NOTES.md` §2 now says exactly that.
  4 new sub-tests plus a cross-bank case on every protected route of both servers. Removing just
  the `aud` comparison fails the token suite and both banks' route suites.

The first two of the original six were done in the 2026-07-14 follow-up pass; the remaining
four in the 2026-07-14 dependency/duplication pass, in the order that made each one cheaper than
the last — the A/B deduplication first, so that the pooling and `request` fixes were one edit
apiece instead of two.

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
- ~~`request@2.88.2` (used for the bridge-server HTTP call) is deprecated/unmaintained and pulls
  in a `tough-cookie` version with a known prototype-pollution CVE (CVE-2023-26136).~~
  **Fixed** (`5c916fa1`, plus `057addd4` for the front ends). The bridge call now goes through
  `node-fetch`, which was already a dependency (`CallbacksA/B` use it), so no package was traded
  for another. Wire format unchanged — still a form-encoded POST, and the tests assert the decoded
  fields the bridge receives. The `!== 200` check was deliberately *not* widened to fetch's `ok`
  (any 2xx): that decides whether a payment is refunded, and refunding one the bridge accepted
  creates money.
  **Removing `request` alone would not have removed the CVE**, which is the part worth recording:
  - `react-scripts` → jest → jsdom → `request` → `tough-cookie` pulled it straight back in.
    `react`/`react-scripts` were declared *production* deps of `infrastructure/` and used by
    nothing — `pageA`, `pageB` and `my-app` each have their own `package.json`, and this package's
    only script is `node --test`.
  - 19 of the 24 declared dependencies (`ajv`, `asn1`, `form-data`, `har-validator`,
    `json-schema`, `jsprim`, …) were `request`'s own transitive tree, hoisted into the manifest.
    With `request` gone they were orphans, and three carried *critical* advisories.
  The manifest now declares the four packages the code actually imports (`express`, `body-parser`,
  `pg`, `node-fetch`). `tough-cookie` no longer appears anywhere in **`infrastructure/`**'s tree,
  which went from ~1500 packages to 81 and from 12 advisories (3 critical) to 8.
  **Still open, deliberately — and `request` is NOT gone from the repo:**
  - `stellar/package.json` still declares `request@^2.88.2`, and `stellar/federationAtest.js` and
    `stellar/test_FSA.js` still call it, so CVE-2023-26136 is still live in `stellar/`'s tree. Those
    are the same two scripts the item above defers ("nobody reads the `error` argument"), and they
    are untestable here — thin CLI wrappers around a live Stellar network, with no test suite and
    nothing offline to drive them. Rewriting them onto `fetch` unattended, with no way to run them,
    is how you break a working script to satisfy an audit. **Whoever picks up that deferred item
    should drop `request` from `stellar/` at the same time: it is now one job, not two.** The
    payment servers — the thing that moves customer money — are clean.
  - The 8 advisories left in `infrastructure/` are express@4's own tree (`qs`, `send`,
    `serve-static`, `cookie`, `path-to-regexp`) and `node-fetch`. Unrelated to this item, and
    clearing them means an express 5 / node-fetch 3 upgrade — a breaking change, not something to
    do unattended.
  A latent hazard was introduced and caught in the process: `.then(onSent).catch(onFailed)` routes
  anything the *success* path throws into the refund handler, so a payment the bridge had accepted
  could still be refunded. Fixed to `.then(onSent, onNotSent)` and pinned by a test (`6ad0df97`).
- ~~Each server holds a single non-pooled `pg.Client` with no reconnect logic — a dropped DB
  connection permanently breaks the process until manual restart, since nothing ever
  reconnects after the initial `client.connect()`.~~
  **Fixed** (`2f086967`). `DBServerA/B` now use a `pg.Pool` — which discards a broken connection
  and opens a new one on the next query — and register an `error` handler, so an idle client
  erroring out doesn't kill the process with an unhandled event. `CallbacksA/B` already had one
  (for `/receive`'s transaction), so both halves of each bank now survive a DB bounce the same way.
  This was **one edit rather than two**, because the handlers had just been deduplicated — the
  first time that item paid for itself. 6 new sub-tests; all 6 fail against the pre-fix source.
- ~~`DBServerA.js`/`DBServerB.js` and `CallbacksA.js`/`CallbacksB.js` are near-byte-for-byte
  duplicates (differing only in a few config constants) — every fix, including several in
  `HARDENING.md`, has to be hand-applied twice, with the ever-present risk of only patching
  one side.~~
  **Fixed** (`80c212ea`). The handlers now live in `dbserver.js` and `callbacks.js`; the four
  original files are the config that genuinely differs (port, domain, connection string, bridge
  entry point, txid range). A fix lands on both banks by construction rather than by discipline —
  the two items above were the first beneficiaries, each a single edit.
  Behaviour-preserving: no handler logic changed in that commit, and the 113 existing tests passed
  unmodified — they still load the real `DBServerA/B` and `CallbacksA/B` files and drive the
  handlers those files register, so the extraction is verified by the same suites that covered the
  copies. Two dead constants didn't survive the move (`Callbacks`' `domain`, declared in both files
  and read by neither).
- ~~The React front ends' actual payment/account logic (`App.js`'s `setAccount`/`payment`/
  `setBank`/`setBalance`) has zero test coverage — the existing tests only cover two small
  presentational components, not the code that drives money movement.~~
  **Fixed** (`b9a27044`). 20 tests per page (6 → 26 each), driving the real component methods
  against a faked `fetch`, so they assert what the browser would actually send and what the user
  would actually be told: `payment()` refuses an empty receiver and a non-positive/non-numeric
  amount without troubling the server; it sends the bearer token and **names no account in the
  body** (naming one used to be all it took to spend someone else's money, so the shape of that
  hole is now pinned shut); it reports the hash and refreshes the balance on success, surfaces the
  server's reason on refusal, and tells the user when the server is unreachable (that last one used
  to fail silently). `login()` won't send half-empty credentials and keeps no token when refused;
  `setAccount()` drops the token on a 401 rather than leaving the UI looking signed in while every
  call it makes is refused. The same suite runs against both pages, for the same reason the server
  suites do.

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
- No live network, blockchain, or database call was made in the 2026-07-14 pass or any of its
  follow-ups. All 145 server tests (103 from the must-have pass, 10 from the `/test` route suite,
  6 for the DB-server pool, 2 for the bridge-refund hazard, 24 from the auth-hardening pass) run
  offline against hand-written `pg`/`express`/`node-fetch` fakes that load the real server files,
  so the route handlers under test are the committed ones, not re-implementations. The `request`
  fake is gone with the package. The front ends carry 27 Jest tests each (was 6), which do run —
  only `react-scripts build` is broken on Node 26, not the test runner.
- The `/login` lockout tests are the one place where a test's own cost mattered: every failed
  login now really does run scrypt (~100ms), that being the production path. The shipped limit of
  5 failures per account is exercised end-to-end against the real `DBServerA/B` files; the
  counting rules that would need dozens of failures (the per-source budget in particular) are
  driven through `createDbServer` with a small budget configured, which is the same handler.
- The one npm command run against the network was `npm install --package-lock-only` in
  `infrastructure/`, to regenerate the lockfile after dropping `request`/`react-scripts`. It
  resolves metadata only and installs nothing; `infrastructure/` still has no `node_modules`, and
  the test suite doesn't need one.
- The Stellar scripts under `stellar/` have no tests: they are thin CLI wrappers whose every
  branch is a call to a live Stellar network, so the promise-error fixes there were reviewed and
  syntax-checked but not driven end-to-end. The equivalent fix in `CallbacksA/B`'s `/test` route
  *is* covered, because that one can be faked offline.
- `react-scripts build` fails in both front ends on Node 26 (`ERR_PACKAGE_PATH_NOT_EXPORTED` from
  a nested `postcss`). Pre-existing — it fails identically on the untouched 2021 code — and not
  something this pass tried to fix. The apps' Jest tests do still run and pass.
