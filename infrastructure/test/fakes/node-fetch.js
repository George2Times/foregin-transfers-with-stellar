// Minimal fake of the `node-fetch` package. CallbacksA.js / CallbacksB.js
// require it at module load for their /test route, which none of the tests
// exercise -- this exists so those files can be loaded offline without the
// real package installed, and it fails loudly if anything ever does call it.

function fetch() {
  return Promise.reject(
    new Error("node-fetch fake: no test should be making a real HTTP call")
  );
}

module.exports = fetch;
