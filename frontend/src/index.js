const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("frontend ok\n");
  })
  .listen(4000, () => console.log("frontend listening on 4000"));
