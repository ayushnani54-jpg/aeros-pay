import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceDir = path.resolve(__dirname, "..");

// Target directory can be passed as argument: node export-clean.mjs [destination_folder]
const customTarget = process.argv[2];
const targetDir = customTarget 
  ? path.resolve(customTarget)
  : path.resolve(sourceDir, "..", "aeros-pay-clean");

console.log("\x1b[36m%s\x1b[0m", "==========================================================");
console.log("\x1b[36m%s\x1b[0m", "   AEROS PAY — 100% CLEAN APP INSTANT EXPORTER TOOL       ");
console.log("\x1b[36m%s\x1b[0m", "==========================================================");
console.log(`Source : ${sourceDir}`);
console.log(`Target : ${targetDir}`);
console.log(`Notice : node_modules (786MB), .next, and temporary files will be excluded.\n`);

const startTime = Date.now();

// Items to exclude from the clean export
const EXCLUDED_PATTERNS = [
  "node_modules",
  ".next",
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  "tsconfig.tsbuildinfo",
  ".DS_Store",
  "Thumbs.db",
];

// Ensure destination exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

let fileCount = 0;
let totalBytes = 0;

function shouldInclude(filePath) {
  const rel = path.relative(sourceDir, filePath);
  if (!rel) return true;
  const segments = rel.split(path.sep);
  for (const seg of segments) {
    if (EXCLUDED_PATTERNS.includes(seg)) return false;
  }
  return true;
}

function copyRecursive(src, dest) {
  if (!shouldInclude(src)) return;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dest);
    fileCount++;
    totalBytes += stat.size;
  }
}

try {
  copyRecursive(sourceDir, targetDir);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);

  console.log("\x1b[32m%s\x1b[0m", "SUCCESS: Clean Application Export Completed!");
  console.log(`  - Total Files Copied : ${fileCount} files`);
  console.log(`  - Total Size Transferred: ${sizeMB} MB (Instead of 800+ MB!)`);
  console.log(`  - Time Elapsed       : ${duration}s`);
  console.log(`  - Destination Folder : ${targetDir}`);
  console.log("\nReady to push or copy anywhere with zero freezing!");
} catch (err) {
  console.error("\x1b[31m%s\x1b[0m", `ERROR: Export failed: ${err.message}`);
  process.exit(1);
}

