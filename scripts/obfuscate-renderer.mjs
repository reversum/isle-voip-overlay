import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(root, "dist", "assets");
if (!fs.existsSync(assetsDir)) {
  console.error("[obfuscate-renderer] dist/assets missing (run vite build first)");
  process.exit(1);
}

const options = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  transformObjectKeys: false,
  simplify: true,
  target: "browser"
};

let count = 0;
for (const file of fs.readdirSync(assetsDir)) {
  if (!file.endsWith(".js")) continue;
  const p = path.join(assetsDir, file);
  const src = fs.readFileSync(p, "utf8");
  const out = JavaScriptObfuscator.obfuscate(src, options).getObfuscatedCode();
  fs.writeFileSync(p, out);
  count += 1;
}
console.log(`[obfuscate-renderer] obfuscated ${count} file(s)`);
