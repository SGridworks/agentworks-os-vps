import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AGENTOS_DATA_DIR) {
  process.env.AGENTOS_DATA_DIR = mkdtempSync(join(tmpdir(), "awo-test-data-"));
}

if (!process.env.VAULT_ROOT) {
  process.env.VAULT_ROOT = mkdtempSync(join(tmpdir(), "awo-test-vault-"));
}
