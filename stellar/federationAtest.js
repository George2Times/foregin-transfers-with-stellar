var request = require("request");

request.get(
  {
    url: "https://www.banka.com:8001/federation",
    qs: {
      q: "johndoe*banka.com",
      type: "name",
    },
  },
  function (error, response, body) {
    console.log(body);
  }
);
