#!/usr/bin/env node

import fs from "fs";
import path from "path";

const PREFIX = "mode_compare_";
const SUFFIX = ".json";
const DEFAULT_KEEP = 30;

function parseArgs(argv) {
  const args = argv.slice(2);
  const keepArgIndex = args.indexOf("--keep");
  const dryRun = args.includes("--dry-run");

  let keep = Number(process.env.MODE_COMPARE_KEEP || DEFAULT_KEEP);
  if (keepArgIndex !== -1 && args[keepArgIndex + 1]) {
    keep = Number(args[keepArgIndex + 1]);
  }

  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("Invalid --keep value. Use a non-negative integer.");
  }

  return { keep, dryRun };
}

function listSnapshotFiles(cwd) {
  return fs.readdirSync(cwd)
    .filter(name => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
    .map(name => {
      const fullPath = path.join(cwd, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function main() {
  const { keep, dryRun } = parseArgs(process.argv);
  const cwd = process.cwd();
  const files = listSnapshotFiles(cwd);

  const keepFiles = files.slice(0, keep);
  const deleteFiles = files.slice(keep);

  console.log(`\nSnapshot retention in ${cwd}`);
  console.log(`Found: ${files.length} | Keep: ${keepFiles.length} | Remove: ${deleteFiles.length}`);
  if (dryRun) {
    console.log("Mode: DRY RUN (no files deleted)");
  }

  for (const file of deleteFiles) {
    if (!dryRun) fs.unlinkSync(file.fullPath);
    console.log(`${dryRun ? "[dry-run] remove" : "removed"}: ${file.name}`);
  }

  console.log("Done.\n");
}

try {
  main();
} catch (err) {
  console.error("Prune failed:", err.message);
  process.exit(1);
}


