// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import * as defaultServer from "./default-server";

const https = require("https");
const fs = require("fs");

defaultServer.start(function (err: Error, app: express.Express) {
  if (err) {
    throw err;
  }

  const httpsEnabled: boolean = Boolean(process.env.HTTPS) || false;
  const port = process.env.PORT || 8080;
  let server: any;

  if (httpsEnabled) {
    const options = {
      key: fs.readFileSync("./certs/cert.key", "utf8"),
      cert: fs.readFileSync("./certs/cert.crt", "utf8"),
    };

    server = https.createServer(options, app).listen(port, function () {
      console.log("API host listening at https://localhost:" + port);
    });
  } else {
    server = app.listen(port, function () {
      console.log("API host listening at http://localhost:" + port);
    });
  }

  server.setTimeout(0);
});
