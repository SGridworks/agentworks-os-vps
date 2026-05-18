import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { initDb, resetDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import {
  createNativeAutomationTemplate,
  createNativeAutomationWorkflow,
  installNativeAutomationTemplate,
  listNativeAutomationRuns,
  listNativeAutomationTemplates,
  listNativeAutomationWorkflows,
  runNativeAutomationWorkflow,
} from "./native-automations.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    companyId: COMPANY_ID,
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: join(dataDir, "vault"),
    dataDir,
    paperclipBaseUrl: "http://127.0.0.1:3100",
    paperclipApiKey: "test",
    jwtSecret: "test",
    googleClientId: "",
    googleClientSecret: "",
    redirectUrl: "",
    allowedOrigins: ["http://localhost:3000"],
    costMeterUrl: "",
    costMeterApiKey: "",
  };
}

describe("native automations", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-native-automations-"));
    config = makeConfig(join(root, "data"));
    previousVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = join(root, "vault");
    _resetVaultStoreForTesting();
    initDb({ config, migrations: migrate });
  });

  afterEach(() => {
    resetDb();
    _resetVaultStoreForTesting();
    if (previousVaultRoot === undefined) {
      delete process.env.VAULT_ROOT;
    } else {
      process.env.VAULT_ROOT = previousVaultRoot;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("installs a template once and marks it installed", () => {
    const workflow = installNativeAutomationTemplate("vault-intake", {
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
    });

    const second = installNativeAutomationTemplate("vault-intake", {
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
    });

    expect(second.id).toBe(workflow.id);
    expect(listNativeAutomationWorkflows(COMPANY_ID)).toHaveLength(1);
    expect(listNativeAutomationTemplates(COMPANY_ID).find((t) => t.id === "vault-intake")?.status).toBe(
      "installed",
    );
  });

  it("runs an installed vault-intake workflow and records step history", async () => {
    const workflow = installNativeAutomationTemplate("vault-intake", {
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
    });

    const run = await runNativeAutomationWorkflow(workflow.id, { source: "test" }, config);

    expect(run.status).toBe("succeeded");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.type).toBe("vault.write");
    expect(run.steps[0]?.status).toBe("succeeded");
    expect(listNativeAutomationRuns(COMPANY_ID, 5)[0]?.id).toBe(run.id);
  });

  it("creates custom templates and managed workflows inside AWOS", () => {
    const definition = {
      trigger: "manual" as const,
      steps: [
        {
          id: "intake",
          name: "Intake webhook",
          type: "webhook.intake" as const,
          params: {},
        },
      ],
    };

    const template = createNativeAutomationTemplate({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Custom Intake Template",
      trigger: "manual",
      description: "Custom operator-created template",
      definition,
    });
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Custom Intake Workflow",
      trigger: "manual",
      description: "Custom operator-created workflow",
      definition,
      status: "paused",
    });

    expect(template.source).toBe("custom");
    expect(listNativeAutomationTemplates(COMPANY_ID).some((t) => t.id === template.id)).toBe(true);
    expect(workflow.status).toBe("paused");
    expect(listNativeAutomationWorkflows(COMPANY_ID).some((w) => w.id === workflow.id)).toBe(true);
  });
});
