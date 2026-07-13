// Shared money-amount parsing for the bank servers.
//
// Every endpoint that moves money (/payment on the DB servers, /receive on the
// callbacks) has to agree on exactly which strings count as a valid amount --
// when the sending side and the receiving side disagree, the difference is
// money that gets created or destroyed in transit. So this lives in one place.

// Parses a client- or bridge-supplied amount into a positive number of dollars,
// rounded to whole cents. Returns null (not NaN, not 0) if the value is not a
// usable amount, so callers must handle the failure explicitly.
//
// Rejects: null/undefined, "", non-numeric junk ("abc" -> NaN), Infinity,
// negatives, and zero. Booleans and objects are rejected outright rather than
// being coerced (Number(true) === 1, Number([]) === 0).
function parseAmount(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;

  var amount = Number(value);
  if (!Number.isFinite(amount)) return null;

  // Work in integer cents so a sub-cent amount can't survive as a rounding
  // artifact (0.001 must be rejected, not silently rounded to 0.00).
  //
  // The toFixed(4) is not decoration: `1.005 * 100` is 100.49999999999999 in
  // binary floating point, so a bare Math.round() would round a half-cent
  // *down*. Fixing the product to 4 decimals absorbs that representation error
  // (which is many orders of magnitude smaller) while leaving a genuine .5
  // cent boundary intact, so half-cents round up as a person would expect.
  var cents = Math.round(Number((amount * 100).toFixed(4)));
  if (cents <= 0) return null;

  return cents / 100;
}

module.exports = { parseAmount };
