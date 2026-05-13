#!/usr/bin/env tsx
import { loadPackFromFile } from "./loader.js";
import { isAbsolute, resolve } from "node:path";

const invocationCwd = process.env.INIT_CWD ?? process.cwd();
const files = process.argv.slice(2).filter((arg) => arg !== "--");

if (files.length === 0 || files.includes("-h") || files.includes("--help")) {
  console.error("Usage: pnpm --filter @agentworks/policy-engine validate:pack -- <pack.yaml> [...]");
  process.exit(files.length === 0 ? 1 : 0);
}

let failed = false;

for (const file of files) {
  const path = isAbsolute(file) ? file : resolve(invocationCwd, file);
  try {
    const pack = await loadPackFromFile(path);
    console.log(`OK ${file} (${pack.pack_id}@${pack.pack_version}, ${pack.rules.length} rules)`);
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FAIL ${file}`);
    console.error(message);
  }
}

if (failed) process.exit(1);
