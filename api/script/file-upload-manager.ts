// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import multer = require("multer");

const UPLOAD_SIZE_LIMIT_MB: number = parseInt(process.env.UPLOAD_SIZE_LIMIT_MB) || 200;

function getAttachUploadFileFunction(maxFileSizeMb: number): express.RequestHandler {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileSizeMb * 1048576,
    },
  }).any();
}

export function fileUploadMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const maxFileSizeMb = UPLOAD_SIZE_LIMIT_MB;
  const attachUploadFile: express.RequestHandler = getAttachUploadFileFunction(maxFileSizeMb);

  attachUploadFile(req, res, (err: any): void => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).send(`The uploaded file is larger than the size limit of ${maxFileSizeMb} megabytes.`);
      } else {
        next(err);
      }
    } else {
      next();
    }
  });
}

export function getFileWithField(req: Express.Request, field: string): Express.Multer.File {
  for (const i in req.files) {
    if (req.files[i].fieldname === field) {
      return req.files[i];
    }
  }

  return null;
}

/**
 * Write an uploaded bundle to a UNIQUE temp file and return its path.
 *
 * WHY THE NAME IS RANDOM: this used to write `path.join(os.tmpdir(), "tempfile")`
 * -- one literal filename for the whole process. management.ts writes it, then
 * reads it back twice (generatePackageManifestFromZip, then
 * addBlob(fs.createReadStream(filePath))) and unlinks it in a `.finally`. Two
 * releases in flight -- `yarn release:android` alongside `yarn release:uwp`, or a
 * CLI release racing the ERP CodePush page -- and B's zip overwrote A's before A
 * had read it. Release A then computed B's manifest and shipped B's BUNDLE into
 * A's deployment, silently, at HTTP 200. That is the exact failure
 * scripts/partners/lib/codePushApps.js was written to prevent, reintroduced one
 * layer down. A's `.finally` unlink also deleted the file B was still reading.
 *
 * This gets MORE likely, not less, after the move off Azure App Service: the
 * response cache and the in-process rate limits mean the new deployment runs a
 * single pinned container, so both releases land in one process rather than
 * being spread across workers.
 */
export function createTempFileFromBuffer(buffer: Buffer): string {
  const tmpPath = require("os").tmpdir();
  const unique = require("crypto").randomUUID();
  const tmpFilePath = require("path").join(tmpPath, `codepush-${unique}.zip`);
  require("fs").writeFileSync(tmpFilePath, buffer);
  return tmpFilePath;
}
