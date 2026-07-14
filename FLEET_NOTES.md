# Fleet notes — things a human has to do

Items from the 2026-07-14 backlog pass that need something I can't get from the
repo: a database I can apply a migration to, or a decision only a person can
make. Everything else in the pass is committed and tested.

## 1. Add a UNIQUE constraint on `transactions.txid` (needs DB access)

`/receive` is now idempotent: it locks the receiving account row (`SELECT ...
FOR UPDATE`) and checks for an already-recorded `txid` before crediting, so a
retried webhook can no longer double-credit a balance.

That check is sound against concurrent deliveries **to the same account**,
because they serialize on the account row lock. The belt-and-braces guarantee is
a database constraint, which the code already handles (`/receive` catches
Postgres error `23505` and treats it as "already credited, respond 200"), but
which I can't add myself — there is no schema file in this repo and no database
I can reach.

Someone with access to the `banka` and `bankb` databases should run:

```sql
ALTER TABLE transactions ADD CONSTRAINT transactions_txid_key UNIQUE (txid);
```

If that fails, there are already duplicate `txid` rows — which would itself be
evidence of the double-crediting bug having fired in the past. Find them with:

```sql
SELECT txid, count(*) FROM transactions GROUP BY txid HAVING count(*) > 1;
```

Note there is no schema/migration file anywhere in the repo (`git ls-files
'*.sql'` is empty), so the table definitions live only in whatever database
instances still exist. Checking a schema file in would be worth doing.

## 2. Provision auth secrets and passwords (needs DB access + a decision)

The payment endpoints now require a bearer token (`infrastructure/auth.js`, and
the new `POST /login` route on each DB server). Two things must happen before
the demo can move money again — neither is something I can do from the repo.

**a. `SESSION_SECRET` must be set** for `DBServerA.js` / `DBServerB.js`. They
refuse to start without it rather than falling back to a baked-in default: a
default signing key committed to a repo lets anyone who has read the repo mint a
valid token for any account, which is not meaningfully better than the
no-authentication state this replaces. Generate one **per bank** with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

*Per bank* still means per bank, but it is no longer load-bearing on its own.
Tokens now name the bank they were issued for, and each server refuses one that
names the other (`aud` in the signed payload, checked by `requireAuth`), so
pasting the same secret into both no longer quietly merges the two banks'
customers — "alice" at bank A and "alice" at bank B are different people with
different money, and a shared secret used to let either one's token spend the
other's balance. Give them separate secrets anyway: with a shared one, each bank
can still *mint* tokens the other will honour, which is a trust you have no
reason to extend.

**b. `users` needs a `password_hash` column, and the demo users need passwords.**
I can't run the migration, and I won't invent passwords for the demo accounts.

```sql
ALTER TABLE users ADD COLUMN password_hash TEXT;
```

Hashes are scrypt in the format `auth.js`'s `hashPassword()` emits. To make one:

```
node -e "console.log(require('./infrastructure/auth').hashPassword('the-password'))"
```

then

```sql
UPDATE users SET password_hash = '<paste>' WHERE friendlyid = 'johndoe';
```

A user whose `password_hash` is NULL cannot log in (`/login` answers 401) and so
cannot transact. That is deliberate — it fails closed — but it does mean **the
demo will not move any money until someone seeds at least one password.**

## 3. Confirm the real allowed CORS origins (a decision)

CORS was `Access-Control-Allow-Origin: *` on every endpoint, so any website could
call the payment API from a logged-in visitor's browser. It's now an allow-list
from the `ALLOWED_ORIGINS` env var (comma-separated), defaulting to
`http://localhost:3000,http://localhost:3001` — the Create React App dev-server
ports where `pageA`/`pageB` run locally.

Localhost is the only origin I can justify from the repo itself. If these apps
are ever served from anywhere else, `ALLOWED_ORIGINS` has to name that origin, or
the browser will block the front end from calling its own API. The one hardcoded
deployment address in the front ends (`20.56.32.165`, in both `App.js` files) is
the dead 2021 Azure VM `HARDENING.md` already flagged — I left it alone rather
than guess at a replacement.

## 4. If you deploy behind a reverse proxy, set `trust proxy` (a decision)

`/login` now locks out a run of failed attempts (see the backlog's nice-to-have
list). There are two budgets: 5 failures locks the *friendly ID*, and 50 locks
the *source address* — the second one being what stops an attacker sidestepping
the first by spraying one common password across many accounts.

The source address comes from `request.ip`, and **Express only populates that
from `X-Forwarded-For` once `app.set('trust proxy', ...)` has been configured.**
These servers currently listen directly, so `request.ip` is the real caller and
the budget works. But if they are ever put behind nginx, a load balancer or a
CDN without that setting, every request will appear to come from the proxy: the
whole internet would share one 50-failure budget, and a single attacker could
lock every customer out of the bank by burning it. That is a worse failure than
the one the budget prevents.

So: direct exposure, nothing to do. Behind a proxy, `app.set('trust proxy', 1)`
(or the proxy's address) in `dbserver.js` — and only trust a proxy you actually
run, because `X-Forwarded-For` is a header the caller writes, and trusting it
from anyone else hands the attacker an unlimited supply of source addresses.

Two other things worth knowing about the lockout, neither of which needs a
decision now:

- It lives in memory, in the server process. Restarting a bank clears its
  failure counts, and two instances of the same bank would not share them. That
  is a deliberate trade — the alternative is a Redis or a database table, and
  this is a single-process demo — but it means the lockout is a speed bump for a
  determined attacker who can force restarts, not a wall.
- The limits are `loginFailuresPerAccount` / `loginFailuresPerSource` in each
  bank's config object (`DBServerA.js`, `DBServerB.js`), defaulting to 5 and 50.
  Neither bank sets them; set them there if the defaults chafe.
