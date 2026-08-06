import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["electron/main.cjs", "electron/preload.cjs"];

const options = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  stringArray: true,
  stringArrayThreshold: 0.6,
  stringArrayEncoding: ["base64"],
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  transformObjectKeys: false,
  reservedStrings: ["uiohook-napi", "get-windows", "electron", "electron-updater"],
  simplify: true,
  target: "node"
};

export function pack() {
  for (const rel of files) {
    const p = path.join(root, rel);
    const bak = p + ".orig";
    if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
    const src = fs.readFileSync(bak, "utf8");
    const out = JavaScriptObfuscator.obfuscate(src, options).getObfuscatedCode();
    fs.writeFileSync(p, out);
  }
}

export function restore() {
  for (const rel of files) {
    const p = path.join(root, rel);
    const bak = p + ".orig";
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, p);
      fs.rmSync(bak);
    }
  }
}

const mode = process.argv[2];
if (mode === "pack") {
  pack();
} else if (mode === "restore") {
  restore();
} else if (mode === "dist") {
  pack();
  try {
    execSync("npx electron-builder", { stdio: "inherit", cwd: root });
  } finally {
    restore();
  }
}
