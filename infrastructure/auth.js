// Authentication for the bank servers.
//
// Before this existed, the payment API had no authentication at all: the caller
// simply named an account in the request body ("friendlyid" / "account") and the
// server acted on it. Anyone who knew (or guessed) a friendly ID could read
// another customer's balance and details via /userdet and /userbal, and drain
// their account via /payment. A friendly ID is a username, not a credential.
//
// So: a password proves who you are (POST /login), and a signed bearer token
// carries that proof on subsequent requests. The critical part is not the token
// format -- it's that the money-moving routes now take the account from the
// *verified token*, never from the request body. A caller can no longer name an
// account it hasn't authenticated as.
//
// No new dependencies: scrypt and HMAC come from Node's built-in crypto.

const crypto = require("crypto");

// scrypt parameters. N=16384 (2^14) is the usual interactive-login baseline;
// it costs ~100ms here, which is negligible for a login and expensive for
// someone working through a stolen table of hashes.
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

// ---------------------------------------------------------------- passwords

// Hashes a password for storage in users.password_hash. Format:
//   scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>
// The parameters are stored alongside the hash so they can be raised later
// without invalidating existing rows.
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

// Verifies a password against a stored hash. Returns false -- never throws --
// for a malformed, empty or NULL stored hash, so a user row with no password
// set simply cannot log in.
function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "hex");
    expected = Buffer.from(parts[5], "hex");
  } catch (error) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N: N, r: r, p: p });
  } catch (error) {
    return false;
  }

  // Compare in constant time: a byte-by-byte early exit leaks how much of the
  // hash a guess got right.
  return crypto.timingSafeEqual(actual, expected);
}

// ------------------------------------------------------------------- tokens

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payloadB64, secret) {
  return base64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
}

// Issues a bearer token asserting "this request is account <friendlyid>",
// signed with the server's secret so a client cannot mint or edit one.
function issueToken(friendlyid, secret, nowSeconds) {
  const now = nowSeconds === undefined ? Math.floor(Date.now() / 1000) : nowSeconds;
  const payload = { sub: friendlyid, exp: now + TOKEN_TTL_SECONDS };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return payloadB64 + "." + sign(payloadB64, secret);
}

// Returns the token's payload, or null if the token is absent, malformed,
// expired, or not signed by `secret`. Callers must treat null as "not
// authenticated" -- there is no partial success here.
function verifyToken(token, secret, nowSeconds) {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expected = sign(payloadB64, secret);

  // Constant-time compare, and length-check first because timingSafeEqual
  // throws on a length mismatch.
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch (error) {
    return null;
  }
  if (!payload || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    return null;
  }

  const now = nowSeconds === undefined ? Math.floor(Date.now() / 1000) : nowSeconds;
  if (payload.exp <= now) return null;

  return payload;
}

// --------------------------------------------------------------- middleware

// Reads the signing secret from the environment, or stops the process.
//
// There is deliberately no default. A hardcoded fallback secret in a public
// repo means anyone who has read the repo can mint a valid token for any
// account -- which is not meaningfully better than the no-authentication state
// this replaces. Refusing to start is the honest failure. See FLEET_NOTES.md.
function requireSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    console.error(
      "SESSION_SECRET is not set (or is too short). The server will not start " +
        "without it -- a default signing key would let anyone mint a token for " +
        "any account. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
    process.exit(1);
  }
  return secret;
}

// Express middleware: rejects the request unless it carries a valid bearer
// token, and otherwise hangs the verified identity off request.auth. Routes
// must read the account from request.auth.friendlyid, NOT from the body.
function requireAuth(secret) {
  return function (request, response, next) {
    const header = request.headers && (request.headers.authorization || request.headers.Authorization);
    const match = typeof header === "string" && header.match(/^Bearer (.+)$/);
    const payload = match ? verifyToken(match[1], secret) : null;

    if (!payload) {
      response.status(401).json({ msg: "ERROR!", error_msg: "Authentication required" });
      return;
    }

    request.auth = { friendlyid: payload.sub };
    next();
  };
}

// Express middleware replacing `Access-Control-Allow-Origin: *`.
//
// The wildcard meant any website in the world could call these endpoints from a
// visitor's browser. Now only origins on the allow-list are reflected back;
// anything else gets no CORS headers and is blocked by the browser.
//
// Note we do not send Access-Control-Allow-Credentials: the API authenticates
// with a bearer token in a header, not a cookie, so the browser has no ambient
// credential to attach and CSRF doesn't apply.
function corsMiddleware(allowedOrigins) {
  const allowed = new Set(allowedOrigins);

  return function (request, response, next) {
    const origin = request.headers && request.headers.origin;

    if (origin && allowed.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    // The response varies by Origin, so it must not be cached across origins.
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    next();
  };
}

// Parses the ALLOWED_ORIGINS env var. Defaults to the Create React App dev
// servers that pageA/pageB run on locally -- the only origins this repo can
// actually justify. See FLEET_NOTES.md.
function allowedOriginsFromEnv() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return ["http://localhost:3000", "http://localhost:3001"];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  requireAuth,
  requireSessionSecret,
  corsMiddleware,
  allowedOriginsFromEnv,
  TOKEN_TTL_SECONDS,
};
