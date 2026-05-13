import { describe, expect, it } from "vitest";
import { CORE_EXECUTION_TABLES, CORE_WORK_GRAPH_SQL } from "./schema-sql.js";

describe("core execution schema SQL", () => {
  it("defines tenant-company-project-issue hierarchy in order", () => {
    const hierarchyTables = ["tenants", "companies", "projects", "issues"];
    const positions = hierarchyTables.map((table) =>
      CORE_WORK_GRAPH_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`)
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("requires every child table to carry tenant ownership", () => {
    for (const table of CORE_EXECUTION_TABLES.filter((table) => table !== "tenants")) {
      const start = CORE_WORK_GRAPH_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
      const next = CORE_WORK_GRAPH_SQL.indexOf("CREATE TABLE", start + 1);
      const body = CORE_WORK_GRAPH_SQL.slice(start, next === -1 ? undefined : next);
      expect(body).toContain("tenant_id uuid NOT NULL");
    }
  });

  it("keeps issues inside projects", () => {
    expect(CORE_WORK_GRAPH_SQL).toContain(
      "project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE"
    );
  });

  it("includes migration source lineage columns", () => {
    for (const column of [
      "source_system text",
      "source_id text",
      "source_import_batch_id text",
      "source_imported_at timestamptz",
    ]) {
      expect(CORE_WORK_GRAPH_SQL).toContain(column);
    }
  });

  it("covers the minimum native lifecycle surface", () => {
    for (const table of [
      "agents",
      "issue_comments",
      "heartbeat_runs",
      "heartbeat_run_events",
      "issue_close_gates",
    ]) {
      expect(CORE_WORK_GRAPH_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
