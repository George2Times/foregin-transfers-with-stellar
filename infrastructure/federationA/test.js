var request = require('request');

request.get({
  url: 'https://www.bankb.​com:8002/federation',
  qs: {
    q: 'johndoe*bankb.​com',
    type: 'name'
  }
}, function(error, response, body) {
  console.log(body);
});