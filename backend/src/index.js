const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("backend ok\n");
  })
  .listen(3000, () => console.log("backend listening on 3000"));
