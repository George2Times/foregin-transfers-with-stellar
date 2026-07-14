# Hardening pass (2026-07-12)

This repo is a 2021-era demo of cross-border payments between two toy
banks ("Bank A" / "Bank B") built on Stellar's old bridge/compliance/
federation server stack, with a Postgres-backed Express API per bank
(`infrastructure/DBServerA.js` / `DBServerB.js`, `CallbacksA.js` /
`CallbacksB.js`) and two near-identical Create React App front ends
(`infrastructure/pageA`, `infrastructure/pageB`). It hasn't been touched
since February 2021. Last commit before this pass: `b37a995a`.

No live network, blockchain, or database calls were made at any point in
this pass. Everything below was fixed and verified offline.

## What was found

### 1. `node_modules` and CRA `build/` output were committed to git (critical, repo-breaking)

`infrastructure/pageA/node_modules` and `infrastructure/pageB/node_modules`
were checked into the repository — **86,240 of the repo's 86,462 tracked
files** (99.7%) were inside `node_modules`. This is not a style nit: it
broke `git clone` on this very machine. Deeply nested files like
`infrastructure/pageA/node_modules/.cache/terser-webpack-plugin/content-v2/sha512/...`
exceed Windows' 260-character path limit, and the clone failed with
`Filename too long` / `unable to create file` errors until `core.longpaths`
was enabled locally just to check out the tree at all. `infrastructure/pageA/build`,
`infrastructure/pageB/build`, and `.eslintcache` files (also generated
output) were committed too. Committed `node_modules/.bin` shims also
turned out to be non-functional after checkout on Windows (git stores
Unix symlinks as plain text files containing the link target when the
checkout host can't create real symlinks, which is exactly what happened
here), so the vendored copy wasn't even usable as a shortcut to "skip
`npm install`" — it was pure dead weight plus a portability landmine.

**Fixed:** untracked `node_modules/`, `build/`, and `.eslintcache` for both
apps via `git rm -r --cached` (files remain on disk, nothing was deleted),
and broadened `.gitignore` (`node_modules/`, `**/node_modules/`,
`**/build/`, `**/.eslintcache`) so they can't be re-committed. No source
file, dependency version, or `package-lock.json` was touched — anyone can
still reproduce the exact same `node_modules` with `npm install`.
**Verified** via `git status` (clean, working tree files unchanged) and by
confirming the removed paths are still present on disk.

### 2. `/payment` endpoint bypassed its own insufficient-balance and DB-error checks (real bug)

In `infrastructure/DBServerA.js` and `infrastructure/DBServerB.js`
(identical bug in both, this is the core "move money" endpoint), the
balance check inside the `/payment` route was missing `return` statements:

```js
if (balance < Number(request.body.amount)) {
  response.json({ msg: "ERROR!", error_msg: "Insufficient balance!" });
  response.end();
}
// execution fell through to here regardless of the check above
var paymentRequestForm = { ... };
requestObj.post({ url: entryPointBS, form: paymentRequestForm }, ...);
```

Because there was no `return`, the handler sent the "insufficient
balance" error response and then **kept going anyway** — it still built a
payment request and POSTed it to the bridge server, and then tried to end
the already-ended HTTP response a second time. The same pattern existed
for the DB-error branch just above it.

**Fixed** by adding the missing `return` statements in both files, so an
insufficient balance or a DB error now stops the handler immediately and
never reaches the bridge call.

**Verified two ways**, offline, no real Postgres/HTTP/network involved:
- Hand-written in-memory fakes for `pg`, `express`, `body-parser`, and
  `request` (`infrastructure/test/fakes/`), wired in via a
  `Module._resolveFilename` hook (`infrastructure/test/mockRequire.js`)
  so the *actual* `DBServerA.js`/`DBServerB.js` source is loaded and its
  real route handlers are invoked — nothing about the fix is
  re-implemented in the test.
- Before writing the fix, I ran the same "insufficient balance" scenario
  against the original (pre-fix) file to confirm the test actually catches
  the bug: it did — the bridge was called (`bridge calls made: 1`) and the
  process then threw an unhandled `TypeError` trying to read a second,
  unqueued DB result. That confirms this was a live, reachable bug, not a
  theoretical one.
- `npm test` in `infrastructure/` (`node --test test/*.test.js`, Node's
  built-in test runner, zero new dependencies) now runs 6 passing tests
  covering the `/payment` handler: insufficient balance, DB error, and the
  happy path (to guard against a fix that accidentally breaks normal
  payments).

  > **Correction (2026-07-14).** As originally written, this bullet claimed
  > those three cases covered "both files' `/payment` handler". They did not.
  > `DBServerA.js` got all three; `DBServerB.js` got only the
  > insufficient-balance case — 3 sub-tests against A, 1 against B. The fix
  > itself *was* applied to both files, so the claim was wrong about the
  > tests, not about the fix. It has since been made true: the `/payment`
  > suite is now written once and run against both servers (13 sub-tests
  > each, 26 total), because these two files are near-identical copies and
  > testing one while eyeballing the other is exactly how a fix ends up
  > half-applied. See the 2026-07-14 pass.

### 3. Several DB-error paths crashed the whole process instead of failing one request

Across `DBServerA.js`, `DBServerB.js`, `CallbacksA.js`, and `CallbacksB.js`,
8 query callbacks did `if (error) { throw error; }`. Throwing inside an
async `pg` callback is an uncaught exception — with no
`uncaughtException` handler anywhere in the project, that terminates the
entire Node process on **any** transient database error (a dropped
connection, a lock timeout, anything), taking down the whole bank server
for every user, not just the one whose request failed.

Additionally, `CallbacksA.js`/`CallbacksB.js`'s `/compliance/ask_user`
handler responded with a 403 on a DB error but then, without a `return`,
unconditionally read `results.rowCount` — `results` is `undefined` on the
error path, so this also threw and crashed the process.

**Fixed:** replaced `throw error` with a graceful JSON error response
(`response.status(500).json({ msg: "ERROR!", ... })`) in all 8 spots, and
added the missing `return` in `/compliance/ask_user` (both files).
**Verified** via `node -c` (syntax check on all 4 modified files) and
manual control-flow tracing; these specific paths weren't wrapped in the
offline test harness (would require simulating every route, which felt
like more scaffolding than this pass warranted) but the fix is the same
one-line pattern already proven correct and tested in finding #2.

### 4. `/userdet` and `/userbal` hung forever when a user wasn't found

In `DBServerA.js`/`DBServerB.js`, if a `SELECT` for a friendly ID returned
zero rows (i.e. unknown user), neither `/userdet` nor `/userbal` sent any
HTTP response at all — the request would just hang until the caller's own
timeout. **Fixed** by adding an explicit `404` JSON response for the
zero-row case in both handlers, in both files.

### 5. No automated test coverage anywhere in the repo

Before this pass, the only test file in the whole project was the
untouched Create React App default (`infrastructure/my-app/src/App.test.js`,
"renders learn react link" — `my-app` itself is dead scaffold, not
referenced by anything else in the repo; see below). `pageA` and `pageB`
had zero tests despite already having Jest/`react-scripts` fully vendored
in their committed `node_modules`.

**Added**, all offline / zero new dependencies:
- `infrastructure/test/dbserver.payment.test.js` — 6 tests covering the
  `/payment` fix in both `DBServerA.js` and `DBServerB.js` (see #2).
- `infrastructure/pageA/src/Components/InputField.test.js` and
  `AddressBar.test.js`, mirrored into `infrastructure/pageB` (identical
  components in both apps) — 6 tests each, using plain `ReactDOM` +
  `react-dom/test-utils` since `@testing-library/react` isn't installed
  in either app. Verified with
  `node node_modules/react-scripts/bin/react-scripts.js test --watchAll=false`
  (both apps: 6/6 passing).
- `infrastructure/package.json`'s `test` script, which previously just did
  `echo "Error: no test specified" && exit 1`, now runs
  `node --test test/*.test.js`. Added `"engines": {"node": ">=18"}` since
  this relies on Node's built-in test runner.

## What was intentionally left alone

- **Stellar keys in `stellar/*.js`** (`CreateAccounts.js`,
  `CreateAssetUSD.js`, `TransferUSD.js`) — these all point at
  `http://127.0.0.1:8000` with `networkPassphrase: "Standalone Network ;
  February 2017"`, which is the standard local-only network spun up by
  Stellar's `quickstart` Docker image. They aren't mainnet or public
  testnet secrets and have no value outside a throwaway local container.
  Left untouched per the "don't touch real keys/secrets" instruction for
  this pass, and because nothing here was run.
- **`.pem` files under `utilities/banka/`, `utilities/bankb/`,
  `utilities/mkcert/`** — file names and the presence of `mkcert` in the
  repo strongly suggest these are `mkcert`-generated local dev TLS certs
  for the fake domains `banka.com`/`bankb.com` (see `utilities/hosts_eg`),
  not real-world secrets. I did not open or print any `-key.pem` file
  during this pass. If this repository is or becomes public, it's still
  worth a human double-checking these aren't anything sensitive and,
  if so, purging them from git history (a rewrite I'm explicitly not
  doing here).
- **Hardcoded local Postgres credentials** (`postgres://bankauser:password1@localhost:5432/...`)
  in `DBServerA.js`/`B.js` and `CallbacksA.js`/`B.js` — a local-only demo
  DB password, not fixed, but worth moving to an env var with the current
  value as fallback if this project is ever revived.
- **Hardcoded dead IP** in `infrastructure/pageA/src/App.js` and
  `pageB/src/App.js` (`const DBServer = '20.56.32.165:3600';`) — almost
  certainly a long-gone 2021 Azure VM. Left as-is since I can't verify
  what it should point to instead; flagging here rather than guessing.
- **`nohup.out` files** at the repo root and under
  `infrastructure/complianceA|B` and `infrastructure/federationA|B` —
  small (5-92 lines) leftover local run logs with fabricated demo data
  ("John Doe", `johndoe*banka.com`). Harmless but shouldn't have been
  committed; left tracked to keep this change surgical, flagging for a
  human to decide whether to purge them.
- **`infrastructure/my-app`** — an untouched, unmodified
  `create-react-app` scaffold (still says "Edit `src/App.js` and save to
  reload"). Not referenced anywhere else in the repo. Looks like dead
  scaffolding from initial project setup; left in place since removing
  it is a judgment call beyond this pass's scope, not a "bug."
- Everything CI/CD, deployment, and dependency-version related — there is
  no CI config in this repo to begin with, and no `package.json`
  dependency versions were changed.
- The compiled `bridge`/`compliance`/`federation` binaries under
  `infrastructure/*/`, `utilities/bridge`, `utilities/compliance`,
  `utilities/federation` — these look like intentionally vendored
  third-party Stellar binaries for local demo use (matching
  `utilities/*.tar.gz` downloads), not build artifacts, so they weren't
  touched.

## Recommendation

The `node_modules`/`build` untracking (finding #1) and the `/payment`
fallthrough fix (finding #2) are both concrete, verified, low-risk, and
worth merging as-is — the first literally fixes "can't clone this repo on
Windows," the second fixes a real correctness bug in the one endpoint
that actually moves money, with a regression test proving both the bug
and the fix. The `throw error` → graceful-response changes (#3) and the
404-on-not-found changes (#4) are small, mechanical, and low-risk but
were verified by reading + syntax-check rather than a full request/response
test, so a second pair of eyes on those specific diffs wouldn't hurt
before merging, purely because they touch more call sites (8 total) than
the DB-error-path fix that already went through a test harness. Nothing
here needs to be treated as urgent — this project has no CI, no
deployment, and (as far as I can tell) no active users — but if it's ever
revived or used as a teaching reference again, the `node_modules` fix in
particular should land first since it currently blocks a clean checkout
on Windows.
