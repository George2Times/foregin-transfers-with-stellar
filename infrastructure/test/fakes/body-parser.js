// Minimal fake of `body-parser`, sufficient for loading the DBServer /
// Callbacks files under test. The real body-parser isn't needed because
// tests call route handlers directly with an already-built `request.body`.

function passthrough(req, res, next) {
  if (typeof next === "function") next();
}

module.exports = {
  json() {
    return passthrough;
  },
  urlencoded() {
    return passthrough;
  },
};
