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
