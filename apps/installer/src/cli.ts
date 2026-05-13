#!/usr/bin/env node
/**
 * agentworks CLI — one-command setup and management for AgentWorks OS
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { loadPackFromFile, evaluatePacks } from "@agentworks/policy-engine";
import { ActionEnvelopeSchema } from "@agentworks/shared";

const VERSION = "0.1.0";
const AGENTWORKS_DIR = process.env.AGENTWORKS_DIR ?? `${process.env.HOME}/.agentworks`;
const COMPOSE_FILE = join(AGENTWORKS_DIR, "docker-compose.yml");

// ANSI color codes
const dim = "\x1b[2m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const yellow = "\x1b[33m";
const cyan = "\x1b[36m";
const reset = "\x1b[0m";

function log(msg: string) {
  console.log(`${dim}[agentworks]${reset} ${msg}`);
}

function logInfo(msg: string) {
  console.log(`${dim}[agentworks]${reset} ${green}[INFO]${reset} ${msg}`);
}

function logWarn(msg: string) {
  console.log(`${dim}[agentworks]${reset} ${yellow}[WARN]${reset} ${msg}`);
}

function logError(msg: string) {
  console.error(`${dim}[agentworks]${reset} ${red}[ERROR]${reset} ${msg}`);
}

function run(cmd: string, opts?: { cwd?: string; input?: string; env?: Record<string, string> }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? AGENTWORKS_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    throw new Error(`Command failed: ${cmd}\n${e.stderr ?? e.message ?? ""}`);
  }
}

function isInstalled(): boolean {
  try {
    const envFile = join(AGENTWORKS_DIR, "config", ".env");
    readFileSync(envFile, "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInstall(_opts: Record<string, unknown>) {
  if (isInstalled()) {
    logError("AgentWorks is already installed.");
    logError(`To reinstall, first run: agentworks uninstall`);
    process.exit(1);
  }

  logInfo("Running one-command install...");
  logInfo("For manual install instructions, visit:");
  logInfo("  https://github.com/SGridworks/agentworks-os#manual-install");

  // Download and run the install script
  try {
    const scriptUrl = process.env["INSTALL_SCRIPT_URL"] ?? "https://raw.githubusercontent.com/SGridworks/agentworks-os/main/apps/installer/src/install.sh";
    logInfo(`Downloading install script from ${scriptUrl}...`);

    // For CI/testing, allow pointing at a local script
    if (process.env["INSTALL_SCRIPT_LOCAL"]) {
      run(`bash ${process.env["INSTALL_SCRIPT_LOCAL"]}`);
    } else {
      run(`curl -fsSL "${scriptUrl}" | bash`);
    }

    logInfo("Installation complete!");
  } catch (err: unknown) {
    logError(`Installation failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function cmdUninstall(_opts: Record<string, unknown>) {
  if (!isInstalled()) {
    logError("AgentWorks is not installed.");
    process.exit(1);
  }

  console.log(`${yellow}This will remove all AgentWorks data and containers.${reset}`);
  console.log(`${yellow}Your vault content and audit logs will be deleted.${reset}`);
  console.log("");
  console.log(`${yellow}Press Enter to confirm, or Ctrl+C to cancel.${reset}`);
  process.stdin.read();

  try {
    logInfo("Stopping services...");
    run(`docker compose -f ${COMPOSE_FILE} down -v --remove-orphans`);

    logInfo("Removing data directory...");
    run(`rm -rf ${AGENTWORKS_DIR}`);

    logInfo("Uninstallation complete.");
    logInfo("Note: Docker images were not removed. To remove them, run:");
    logInfo(`  docker rmi ghcr.io/sgridworks/agentworks-os/agentos-d:latest`);
    logInfo(`  docker rmi ghcr.io/sgridworks/agentworks-os/scanner-worker:latest`);
    logInfo(`  docker rmi postgres:16-alpine`);
    logInfo(`  docker rmi n8nio/n8n:1.68.0`);
  } catch (err: unknown) {
    logError(`Uninstall failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function cmdStatus(_opts: Record<string, unknown>) {
  if (!isInstalled()) {
    logError("AgentWorks is not installed.");
    process.exit(1);
  }

  const daemonUrl = getDaemonUrl();
  try {
    const output = run(`docker compose -f ${COMPOSE_FILE} ps`);
    console.log(output);
    // Also hit the admin status endpoint
    try {
      const httpRes = run(`curl -s -X GET "${daemonUrl}/api/admin/status" || echo "daemon unreachable"`);
      if (httpRes.trim() !== "daemon unreachable") {
        console.log("");
        console.log("Daemon status:");
        console.log(httpRes.trim());
      }
    } catch {
      // daemon not responding is OK for status
    }
  } catch {
    logError("Failed to get status. Are Docker services running?");
    process.exit(1);
  }
}

function getDaemonUrl(): string {
  // agentos-d port from env or default 3100
  const port = process.env["AGENTWORKS_DAEMON_PORT"] ?? "3100";
  return `http://localhost:${port}`;
}

async function cmdPauseResume(action: "pause" | "resume") {
  if (!isInstalled()) {
    logError("AgentWorks is not installed.");
    process.exit(1);
  }

  const daemonUrl = getDaemonUrl();
  const paused = action === "pause";
  const label = paused ? "Pausing" : "Resuming";

  logInfo(`${label} daemon services...`);

  try {
    const res = run(
      `curl -s -w "\\n%{http_code}" -X PATCH "${daemonUrl}/api/admin/pause" ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"paused":${paused}}'`,
    );
    const lines = res.trim().split("\n");
    const body = lines.slice(0, -1).join("\n");
    const statusCode = lines[lines.length - 1] ?? "000";

    if (statusCode === "200") {
      logInfo(`Daemon ${paused ? "paused" : "resumed"} successfully.`);
      if (body) {
        try {
          const json = JSON.parse(body);
          console.log(`  paused: ${json.paused}`);
          if (json.reason) console.log(`  reason: ${json.reason}`);
        } catch {
          // not JSON, just print raw
          if (body) console.log(`  ${body}`);
        }
      }
    } else if (statusCode === "503" && paused) {
      // Already paused
      logInfo("Daemon is already paused.");
    } else if (statusCode === "404") {
      logError(`Daemon admin endpoint not found. Is agentos-d running on port ${process.env["AGENTWORKS_DAEMON_PORT"] ?? 3100}?`);
      process.exit(1);
    } else {
      logError(`Daemon returned ${statusCode}: ${body}`);
      process.exit(1);
    }
  } catch (err: unknown) {
    logError(`Failed to ${action} daemon: ${(err as Error).message}`);
    logError("Is the agentos-d daemon running? Try: agentworks status");
    process.exit(1);
  }
}

function cmdLogs(opts: { follow?: boolean; service?: string }) {
  if (!isInstalled()) {
    logError("AgentWorks is not installed.");
    process.exit(1);
  }

  const args = ["docker compose", "-f", COMPOSE_FILE, "logs"];
  if (opts.follow) args.push("-f");
  if (opts.service) args.push(opts.service);

  try {
    run(args.join(" "), { cwd: AGENTWORKS_DIR });
  } catch {
    logError("Failed to fetch logs.");
    process.exit(1);
  }
}

function cmdVersion(_opts: Record<string, unknown>) {
  // Check docker image version first
  let imageVersion = "unknown";
  try {
    const output = run(`docker images ghcr.io/sgridworks/agentworks-os/agentos-d:latest --format "{{.Tag}}" 2>/dev/null || echo "not-installed"`);
    imageVersion = output.trim() || "unknown";
  } catch {
    imageVersion = "not-installed";
  }

  console.log(`agentworks CLI: ${VERSION}`);
  console.log(`agentos-d image: ${imageVersion}`);
}

function cmdUpdate(opts: { check?: boolean }) {
  if (!isInstalled()) {
    logError("AgentWorks is not installed.");
    process.exit(1);
  }

  if (opts.check) {
    logInfo("Checking for updates...");
    // Future: check GitHub releases API
    logInfo("Update check not yet implemented. Images are tagged 'latest'.");
    return;
  }

  logInfo("Pulling latest images...");
  try {
    run(`docker compose -f ${COMPOSE_FILE} pull`);
    logInfo("Pull complete. Restarting services...");
    run(`docker compose -f ${COMPOSE_FILE} up -d`);
    logInfo("Update complete.");
  } catch (err: unknown) {
    logError(`Update failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function cmdBackup(opts: { output?: string; passphrase?: string; vaultPath?: string }) {
  if (!isInstalled()) {
    logError("AgentWorks is not installed.");
    process.exit(1);
  }

  const passphrase = opts.passphrase ?? process.env["AGENTWORKS_BACKUP_PASSPHRASE"];
  if (!passphrase) {
    logError("Passphrase required. Set AGENTWORKS_BACKUP_PASSPHRASE env var or use --passphrase.");
    process.exit(1);
  }

  const vaultPath = opts.vaultPath ?? process.env["AGENTWORKS_VAULT_PATH"] ?? `${process.env["HOME"]}/vault`;
  const timestamp = new Date().toISOString().slice(0, 10);
  const outputPath = opts.output ?? `agentworks-backup-${timestamp}.tar.gz.enc`;
  const tmpDir = `${AGENTWORKS_DIR}/.backup-tmp-${Date.now()}`;
  const dbPath = join(AGENTWORKS_DIR, "data", "agentworks.db");

  logInfo(`Creating encrypted backup: ${outputPath}`);

  try {
    // Ensure data dir exists (v1 uses SQLite, not postgres)
    run(`mkdir -p "${tmpDir}"`);

    // Copy vault
    if (!vaultPath.startsWith(AGENTWORKS_DIR)) {
      // Vault is outside AGENTWORKS_DIR — copy it into tmpDir under "vault"
      run(`mkdir -p "${tmpDir}/vault"`);
      run(`cp -r "${vaultPath}/." "${tmpDir}/vault/"`);
    } else {
      // Vault is inside AGENTWORKS_DIR (e.g. a symlink or subdir)
      run(`cp -r "${vaultPath}" "${tmpDir}/vault"`);
    }

    // Copy SQLite DB (v1 — not postgres)
    if (dbPath) {
      run(`mkdir -p "${tmpDir}/data"`);
      run(`cp "${dbPath}" "${tmpDir}/data/agentworks.db"`);
    }

    // Copy config (secrets, .env, etc.)
    run(`cp -r "${AGENTWORKS_DIR}/config" "${tmpDir}/config"`);

    // Write manifest metadata into the backup root
    const manifest = JSON.stringify({
      version: "1",
      created_at: new Date().toISOString(),
      vault_path: vaultPath,
      db_path: "data/agentworks.db",
      config_path: "config",
      type: "sqlite-v1",
    }, null, 2);
    run(`echo '${manifest.replace(/'/g, "'\"'\"'")}' > "${tmpDir}/backup-manifest.json"`);

    // Tar the directory
    run(`tar -czf "${tmpDir}.tar.gz" -C "${tmpDir}" .`);
    run(`rm -rf "${tmpDir}"`);

    // Encrypt with AES-256-CBC + PBKDF2 (100k iters). GCM mode is NOT
    // supported by `openssl enc` (it requires explicit IV/tag handling that
    // the enc command can't do); CBC+PBKDF2 is the supported recipe and is
    // adequate for a passphrase-protected at-rest backup.
    run(
      `openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass env:AGENTWORKS_BACKUP_PASSPHRASE -in "${tmpDir}.tar.gz" -out "${outputPath}"`,
      { env: { AGENTWORKS_BACKUP_PASSPHRASE: passphrase } },
    );
    run(`rm -f "${tmpDir}.tar.gz"`);

    logInfo(`Backup created: ${outputPath}`);
    logInfo(`Vault: ${vaultPath}`);
    logInfo(`DB: ${dbPath}`);
    logInfo("IMPORTANT: Store the passphrase securely. Without it, the backup cannot be restored.");
  } catch (err: unknown) {
    logError(`Backup failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function cmdRestore(opts: { backup: string; passphrase?: string; targetVaultPath?: string }) {
  if (!isInstalled()) {
    logError("AgentWorks must be installed before restoring.");
    process.exit(1);
  }

  const passphrase = opts.passphrase ?? process.env["AGENTWORKS_BACKUP_PASSPHRASE"];
  if (!passphrase) {
    logError("Passphrase required. Set AGENTWORKS_BACKUP_PASSPHRASE env var or use --passphrase.");
    process.exit(1);
  }

  const backupPath = opts.backup;
  const tmpDir = `${AGENTWORKS_DIR}/.restore-tmp-${Date.now()}`;

  logInfo(`Restoring from backup: ${backupPath}`);

  try {
    // Decrypt the backup
    logInfo("Decrypting backup...");
    run(`mkdir -p "${tmpDir}"`);
    run(
      `openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000 -salt -pass env:AGENTWORKS_BACKUP_PASSPHRASE -in "${backupPath}" -out "${tmpDir}.tar.gz"`,
      { env: { AGENTWORKS_BACKUP_PASSPHRASE: passphrase } },
    );

    // Stop services before restoring
    logInfo("Stopping services...");
    run(`docker compose -f ${COMPOSE_FILE} down`);

    // Extract backup
    logInfo("Extracting backup...");
    run(`tar -xzf "${tmpDir}.tar.gz" -C "${tmpDir}"`);

    // Read manifest to determine structure
    const manifestPath = join(tmpDir, "backup-manifest.json");
    let manifest: { version: string; created_at: string; vault_path?: string; type?: string } | null = null;
    try {
      const content = readFileSync(manifestPath, "utf-8");
      manifest = JSON.parse(content);
    } catch {
      logWarn("No manifest found in backup — assuming v1 SQLite format.");
    }

    // Restore vault
    const vaultBackupDir = join(tmpDir, "vault");
    const vaultTarget = opts.targetVaultPath ?? process.env["AGENTWORKS_VAULT_PATH"] ?? `${process.env["HOME"]}/vault`;
    if (existsSync(vaultBackupDir)) {
      logInfo(`Restoring vault to: ${vaultTarget}`);
      run(`mkdir -p "${vaultTarget}"`);
      run(`cp -r "${vaultBackupDir}/." "${vaultTarget}/"`);
    }

    // Restore config
    const configBackupDir = join(tmpDir, "config");
    if (existsSync(configBackupDir)) {
      logInfo("Restoring config...");
      run(`cp -r "${configBackupDir}/." "${AGENTWORKS_DIR}/config/"`);
    }

    // Restore SQLite DB (v1)
    const dbBackupPath = join(tmpDir, "data", "agentworks.db");
    const dbTargetDir = join(AGENTWORKS_DIR, "data");
    if (existsSync(dbBackupPath)) {
      logInfo("Restoring database...");
      run(`mkdir -p "${dbTargetDir}"`);
      run(`cp "${dbBackupPath}" "${dbTargetDir}/agentworks.db"`);
    }

    // Cleanup
    run(`rm -rf "${tmpDir}" "${tmpDir}.tar.gz"`);

    // Restart services
    logInfo("Starting services...");
    run(`docker compose -f ${COMPOSE_FILE} up -d`);

    logInfo("Restore complete.");
    if (manifest?.created_at) {
      logInfo(`Backup created: ${manifest.created_at}`);
    }
  } catch (err: unknown) {
    logError(`Restore failed: ${(err as Error).message}`);
    logError("Hint: Verify the passphrase is correct and the backup file is not corrupted.");
    // Attempt to restart services on failure
    try {
      run(`docker compose -f ${COMPOSE_FILE} up -d`);
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

async function collectPackPaths(target: string): Promise<string[]> {
  const abs = resolve(target);
  if (!existsSync(abs)) {
    throw new Error(`Path not found: ${abs}`);
  }
  const stat = statSync(abs);
  if (stat.isFile()) return [abs];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      out.push(join(abs, entry.name));
    } else if (entry.isDirectory()) {
      const nested = await collectPackPaths(join(abs, entry.name));
      out.push(...nested);
    }
  }
  return out;
}

async function cmdPackValidate(positionals: string[]) {
  const target = positionals[0];
  if (!target) {
    logError("pack validate requires a path argument.");
    logError("Usage: agentworks pack validate <path>");
    process.exit(1);
  }

  let paths: string[];
  try {
    paths = await collectPackPaths(target);
  } catch (err: unknown) {
    logError((err as Error).message);
    process.exit(1);
  }

  if (paths.length === 0) {
    logError(`No YAML files found under ${target}`);
    process.exit(1);
  }

  let okCount = 0;
  const failures: { path: string; error: string }[] = [];

  for (const path of paths) {
    try {
      const pack = await loadPackFromFile(path);
      console.log(`${green}OK${reset}   ${path}  →  ${cyan}${pack.pack_id}${reset}  (${pack.rules.length} rules)`);
      okCount++;
    } catch (err: unknown) {
      const msg = (err as Error).message.split("\n")[0] ?? "unknown error";
      console.log(`${red}FAIL${reset} ${path}  →  ${msg}`);
      failures.push({ path, error: msg });
    }
  }

  console.log("");
  console.log(`${dim}---${reset}`);
  console.log(`${green}${okCount} ok${reset}, ${red}${failures.length} failed${reset} (${paths.length} total)`);

  if (failures.length > 0) {
    process.exit(1);
  }
}

async function cmdPackDryRun(positionals: string[], values: { action?: string; "action-file"?: string }) {
  const target = positionals[0];
  if (!target) {
    logError("pack dry-run requires a path argument.");
    logError("Usage: agentworks pack dry-run <path> --action='<json>' | --action-file <path>");
    process.exit(1);
  }

  let actionJson: string | undefined;
  if (values["action-file"]) {
    try {
      actionJson = readFileSync(values["action-file"], "utf-8");
    } catch (err: unknown) {
      logError(`Failed to read --action-file: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (values.action) {
    actionJson = values.action;
  } else {
    logError("--action='<json>' or --action-file <path> required.");
    process.exit(1);
  }

  let actionRaw: unknown;
  try {
    actionRaw = JSON.parse(actionJson);
  } catch (err: unknown) {
    logError(`Invalid JSON in --action: ${(err as Error).message}`);
    process.exit(1);
  }

  const parsed = ActionEnvelopeSchema.safeParse(actionRaw);
  if (!parsed.success) {
    logError("Action does not match RFC 001 ActionEnvelope shape:");
    for (const issue of parsed.error.issues) {
      logError(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  let paths: string[];
  try {
    paths = await collectPackPaths(target);
  } catch (err: unknown) {
    logError((err as Error).message);
    process.exit(1);
  }

  const packs = [];
  for (const path of paths) {
    try {
      packs.push(await loadPackFromFile(path));
    } catch (err: unknown) {
      logWarn(`Skipping unloadable pack ${path}: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  if (packs.length === 0) {
    logError("No valid rule packs to evaluate against.");
    process.exit(1);
  }

  const result = evaluatePacks(packs, parsed.data, false);

  const decisionColor = result.decision === "block" ? red : result.decision === "route_to_review" ? yellow : green;
  console.log("");
  console.log(`${dim}action:${reset}    ${parsed.data.actionKind}  (actor=${parsed.data.actor.label})`);
  console.log(`${dim}packs:${reset}     ${packs.length} loaded`);
  console.log(`${dim}decision:${reset}  ${decisionColor}${result.decision.toUpperCase()}${reset}`);
  console.log(`${dim}reason:${reset}    ${result.reason}`);
  if (result.matchedRule) {
    console.log(`${dim}rule:${reset}      ${result.matchedRule.rule_id}  (${result.matchedRule.name})`);
  }
  if (result.citation) {
    console.log(`${dim}citation:${reset}  ${result.citation}`);
  }
  if (result.missingFields?.length) {
    console.log(`${dim}missing:${reset}   ${result.missingFields.join(", ")}`);
  }
  console.log("");

  if (result.decision === "block") process.exit(2);
  if (result.decision === "route_to_review") process.exit(3);
  process.exit(0);
}

async function cmdPack(positionals: string[], values: Record<string, unknown>) {
  const sub = positionals[0];
  const rest = positionals.slice(1);

  switch (sub) {
    case "validate":
      await cmdPackValidate(rest);
      return;
    case "dry-run":
      await cmdPackDryRun(rest, values as { action?: string; "action-file"?: string });
      return;
    default:
      logError(`Unknown pack subcommand: ${sub ?? "(none)"}`);
      console.log("");
      console.log("Pack subcommands:");
      console.log("  agentworks pack validate <path>           Validate a YAML rule pack (or directory of packs)");
      console.log("  agentworks pack dry-run  <path> --action  Evaluate an action against a pack (or directory)");
      process.exit(1);
  }
}

async function cmdPolicyDescribe(positionals: string[]) {
  const target = positionals[0];
  if (!target) {
    logError("policy describe requires a path argument.");
    logError("Usage: agentworks policy describe <pack-path>");
    process.exit(3);
  }
  let paths: string[];
  try {
    paths = await collectPackPaths(target);
  } catch (err: unknown) {
    logError((err as Error).message);
    process.exit(3);
  }
  if (paths.length === 0) {
    logError(`No YAML files found under ${target}`);
    process.exit(3);
  }
  for (const path of paths) {
    let pack;
    try {
      pack = await loadPackFromFile(path);
    } catch (err: unknown) {
      console.log(`${red}FAIL${reset} ${path}  →  ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    console.log("");
    console.log(`${cyan}${pack.pack_id}${reset}  v${pack.pack_version}`);
    if (pack.pack_name) console.log(`  ${dim}name:${reset} ${pack.pack_name}`);
    if (pack.industry) console.log(`  ${dim}industry:${reset} ${pack.industry}`);
    if (pack.target_action_kinds?.length) {
      console.log(`  ${dim}targets:${reset} ${pack.target_action_kinds.join(", ")}`);
    }
    console.log(`  ${dim}rules (${pack.rules.length}):${reset}`);
    for (const r of pack.rules) {
      const firstThen = r.conditions?.[0]?.then;
      const decision = (firstThen?.decision as string | undefined) ?? "(unset)";
      const decColor = decision === "block" ? red : decision === "route_to_review" ? yellow : green;
      console.log(`    - ${r.rule_id}  ${decColor}${decision}${reset}  ${r.name ?? ""}`);
    }
  }
  process.exit(0);
}

// Wraps cmdPackDryRun's behavior to satisfy AWO-196's exit-code mapping:
//   0 = allow, 1 = route_to_review, 2 = block, 3 = error.
// Existing pack dry-run uses 0/2/3 — translate via subprocess pattern.
async function cmdPolicyDryRun(positionals: string[], values: { action?: string; "action-file"?: string }) {
  const [target, actionPath] = positionals;
  if (!target) {
    logError("Usage: agentworks policy dry-run <pack-path> <action.json>");
    process.exit(3);
  }
  // Allow positional action.json as a shorthand for --action-file
  const opts: { action?: string; "action-file"?: string } = { ...values };
  if (actionPath && !opts.action && !opts["action-file"]) {
    opts["action-file"] = actionPath;
  }
  // Re-throw with AWO-196 exit code mapping
  const realExit = process.exit.bind(process);
  process.exit = ((code?: number): never => {
    if (code === 0) realExit(0);
    if (code === 2) realExit(2);             // block stays 2
    if (code === 3) realExit(1);             // route_to_review (was 3) -> 1
    realExit(3);                              // any error -> 3
    throw new Error("unreachable");
  }) as typeof process.exit;
  try {
    await cmdPackDryRun([target], opts);
  } finally {
    process.exit = realExit;
  }
}

async function cmdPolicy(positionals: string[], values: Record<string, unknown>) {
  const sub = positionals[0];
  const rest = positionals.slice(1);
  switch (sub) {
    case "validate":
      await cmdPackValidate(rest);
      return;
    case "dry-run":
      await cmdPolicyDryRun(rest, values as { action?: string; "action-file"?: string });
      return;
    case "describe":
      await cmdPolicyDescribe(rest);
      return;
    default:
      logError(`Unknown policy subcommand: ${sub ?? "(none)"}`);
      console.log("");
      console.log("Policy subcommands:");
      console.log("  agentworks policy validate <path>");
      console.log("  agentworks policy dry-run  <pack-path> <action.json>");
      console.log("  agentworks policy describe <path>");
      process.exit(3);
  }
}

function cmdHelp() {
  console.log(`
${cyan}agentworks${reset} — AI compliance firewall for regulated SMBs

${green}Usage:${reset}
  agentworks <command> [options]

${green}Commands:${reset}
  install           Install AgentWorks OS (one-command setup)
  uninstall         Remove AgentWorks OS and all data
  status            Show service status (includes daemon pause state)
  pause             Pause the daemon (stops policy evaluation, dispatch)
  resume            Resume a paused daemon
  logs [service]    Show service logs (use -f to follow)
  version           Show version information
  update            Update to latest version (--check for dry-run)
  backup [path]     Create encrypted backup (set AGENTWORKS_BACKUP_PASSPHRASE env var or use --passphrase)
  restore <path>    Restore from encrypted backup (set AGENTWORKS_BACKUP_PASSPHRASE or use --passphrase)
  pack validate <path>             Validate a YAML rule pack (or directory of packs)
  pack dry-run <path> --action=... Evaluate an action JSON against a pack (or directory)

${green}Options:${reset}
  -h, --help        Show this help message
  -v, --version     Show CLI version

${green}Examples:${reset}
  agentworks install
  agentworks status
  agentworks logs -f agentos-d
  agentworks backup ~/agentworks-backup.tar.gz
  agentworks restore ~/agentworks-backup.tar.gz
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    follow: { type: "boolean", short: "f" },
    check: { type: "boolean" },
    output: { type: "string", short: "o" },
    service: { type: "string", short: "s" },
    passphrase: { type: "string" },
    "vault-path": { type: "string" },
    "target-vault-path": { type: "string" },
    action: { type: "string" },
    "action-file": { type: "string" },
  },
  allowPositionals: true,
});

const [command = "help", ...positionalArgs] = positionals;

if (values.help || command === "help") {
  cmdHelp();
  process.exit(0);
}

if (values.version) {
  cmdVersion({});
  process.exit(0);
}

switch (command) {
  case "install":
    cmdInstall(values);
    break;
  case "uninstall":
    cmdUninstall(values);
    break;
  case "status":
    cmdStatus(values);
    break;
  case "logs": {
    const logsOpts: { follow?: boolean; service?: string } = {};
    if (values.follow !== undefined) logsOpts.follow = values.follow;
    if (values.service !== undefined) logsOpts.service = values.service;
    cmdLogs(logsOpts);
    break;
  }
  case "version":
    cmdVersion({});
    break;
  case "update": {
    const updateOpts: { check?: boolean } = {};
    if (values.check !== undefined) updateOpts.check = values.check;
    cmdUpdate(updateOpts);
    break;
  }
  case "backup": {
    const backupOpts: { output?: string; passphrase?: string; vaultPath?: string } = {};
    if (values.output !== undefined) backupOpts.output = values.output;
    if (values.passphrase !== undefined) backupOpts.passphrase = values.passphrase;
    if (values["vault-path"] !== undefined) backupOpts.vaultPath = values["vault-path"];
    cmdBackup(backupOpts);
    break;
  }
  case "pack": {
    await cmdPack(positionalArgs, values);
    break;
  }
  case "policy": {
    await cmdPolicy(positionalArgs, values);
    break;
  }
  case "pause":
    await cmdPauseResume("pause");
    break;
  case "resume":
    await cmdPauseResume("resume");
    break;
  case "restore": {
    const backupArg = positionalArgs[0];
    if (!backupArg) {
      logError("restore requires a backup path argument.");
      cmdHelp();
      process.exit(1);
    }
    const restoreOpts: { backup: string; passphrase?: string; targetVaultPath?: string } = { backup: backupArg };
    if (values.passphrase !== undefined) restoreOpts.passphrase = values.passphrase;
    if (values["target-vault-path"] !== undefined) restoreOpts.targetVaultPath = values["target-vault-path"];
    cmdRestore(restoreOpts);
    break;
  }
  default:
    logError(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
}
