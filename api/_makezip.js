const yazl = require("yazl");
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const out = path.join(root, "deploy.zip");
const zip = new yazl.ZipFile();
const INCLUDE = ["bin", "package.json", "package-lock.json", "node_modules"];
let n = 0;
function addDir(absDir, relBase) {
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const rel = (relBase ? relBase + "/" : "") + name;
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) addDir(abs, rel);
    else if (st.isFile()) { zip.addFile(abs, rel); n++; }
  }
}
for (const e of INCLUDE) {
  const abs = path.join(root, e);
  if (!fs.existsSync(abs)) { console.error("MISSING:", e); process.exit(2); }
  if (fs.statSync(abs).isDirectory()) addDir(abs, e);
  else { zip.addFile(abs, e); n++; }
}
zip.outputStream.pipe(fs.createWriteStream(out)).on("close", () => console.log("ZIP DONE files:", n));
zip.end();
