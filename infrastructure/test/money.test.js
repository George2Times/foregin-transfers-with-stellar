// Unit tests for the shared amount parser.
//
// The truncation bug this replaces lived in /receive:
//   parseInt(Number("12.75").toFixed(2))  ===  12
// which credited the receiver $12.00 for a payment the sender was debited
// $12.75 for. The first test below is that exact case.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseAmount } = require("../money");

test("parseAmount keeps the cents (the /receive truncation bug)", () => {
  // What the old expression did, for the record:
  assert.equal(parseInt(Number("12.75").toFixed(2)), 12);
  // What we do now:
  assert.equal(parseAmount("12.75"), 12.75);

  assert.equal(parseAmount("0.01"), 0.01);
  assert.equal(parseAmount("99.99"), 99.99);
  assert.equal(parseAmount(12.75), 12.75);
  assert.equal(parseAmount("100"), 100);
});

test("parseAmount rounds to whole cents", () => {
  assert.equal(parseAmount("1.005"), 1.01);
  assert.equal(parseAmount("1.004"), 1);
  // Sub-cent amounts round to zero, which is not a payment.
  assert.equal(parseAmount("0.001"), null);
});

test("parseAmount rejects anything that isn't a positive amount", () => {
  for (const bad of [
    // A negative amount reaching /payment used to *increase* the sender's
    // balance instead of decreasing it.
    "-5", -5, "-0.01",
    // Non-numeric junk used to corrupt a balance to NaN.
    "abc", "", "   ", "12.5abc", "1e", {}, [], true, false, null, undefined,
    // Zero is not a payment.
    "0", 0, "0.00",
    // Not a finite amount.
    "Infinity", Infinity, -Infinity, NaN, "NaN",
  ]) {
    assert.equal(
      parseAmount(bad),
      null,
      `parseAmount(${JSON.stringify(bad)}) must be rejected, got ${parseAmount(bad)}`
    );
  }
});
