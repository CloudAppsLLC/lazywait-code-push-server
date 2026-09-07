#!/usr/bin/env node
//
// make-deploy-zip.js -- build an App Service deployment archive with POSIX paths.
//
// WHY THIS EXISTS: it replaces
//     powershell Compress-Archive -Path ./bin,./package.json -DestinationPath ./deploy.zip
// which is what both package.json "zip" scripts used to run, and which produces
// an archive that CANNOT WORK on Linux App Service.
//
// PowerShell's Compress-Archive writes entry names with BACKSLASH separators:
//
//     bin\server.js          <- one file whose NAME contains a backslash
//     bin/server.js          <- what a Linux host needs
//
// The zip spec (APPNOTE 4.4.17.1) requires forward slashes. Linux unzips the
// first form as a single file literally called `bin\server.js` sitting at the
// archive root, so the directory `bin/` never exists and node dies with
//
//     Error: Cannot find module '/home/site/wwwroot/bin/server.js'
//
// while `az webapp deploy` reports "Deployment successful" and the site answers
// 503. That combination cost ~35 minutes of fleet-wide OTA downtime on
// 2026-09-07 during the CodePush migration, and it is invisible from Windows,
// where the same archive extracts perfectly.
//
// The failure is silent in both directions -- a green deploy and a dead site --
// so it is worth a script rather than a comment telling people to be careful.
//
// USAGE
//   node api/scripts/make-deploy-zip.js <out.zip> <path> [path...]
//
// Directories are added recursively. Paths are relative to CWD, so run it from
// the package being deployed.

const fs = require("fs");
const path = require("path");
const yazl = require("yazl");

const [, , outFile, ...inputs] = process.argv;

if (!outFile || inputs.length === 0) {
  console.error("usage: node make-deploy-zip.js <out.zip> <path> [path...]");
  process.exit(2);
}

const zip = new yazl.ZipFile();
let fileCount = 0;

/** Always emit `a/b/c`, never `a\b\c`, whatever platform this runs on. */
function posix(p) {
  return p.split(path.sep).join("/");
}

function addPath(diskPath, entryName) {
  const stat = fs.statSync(diskPath);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(diskPath)) {
      addPath(path.join(diskPath, child), entryName + "/" + child);
    }
    return;
  }
  zip.addFile(diskPath, posix(entryName));
  fileCount++;
}

for (const input of inputs) {
  const clean = input.replace(/^\.[\\/]/, "").replace(/[\\/]$/, "");
  if (!fs.existsSync(clean)) {
    console.error(`make-deploy-zip: '${clean}' does not exist -- run the build first?`);
    process.exit(1);
  }
  addPath(clean, posix(clean));
}

zip.end();
const out = fs.createWriteStream(outFile);
zip.outputStream.pipe(out).on("close", () => {
  const kb = Math.round(fs.statSync(outFile).size / 1024);
  console.log(`make-deploy-zip: wrote ${outFile} (${fileCount} files, ${kb} KB, POSIX paths)`);
});
