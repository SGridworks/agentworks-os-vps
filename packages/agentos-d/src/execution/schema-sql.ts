export const CORE_WORK_GRAPH_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  memory_root text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz
);

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  issue_prefix text NOT NULL DEFAULT 'AWO',
  issue_counter integer NOT NULL DEFAULT 0,
  budget_monthly_cents integer NOT NULL DEFAULT 0,
  spent_monthly_cents integer NOT NULL DEFAULT 0,
  brand_color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz,
  UNIQUE (tenant_id, issue_prefix)
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'backlog',
  color text,
  target_date date,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'general',
  title text,
  status text NOT NULL DEFAULT 'idle',
  reports_to uuid REFERENCES agents(id) ON DELETE SET NULL,
  adapter_type text NOT NULL DEFAULT 'process',
  adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  runtime_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_monthly_cents integer NOT NULL DEFAULT 0,
  spent_monthly_cents integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz
);

CREATE TABLE IF NOT EXISTS issues (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  assignee_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'backlog',
  priority text NOT NULL DEFAULT 'medium',
  issue_number integer,
  identifier text,
  origin_kind text NOT NULL DEFAULT 'manual',
  origin_id text,
  billing_code text,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz,
  UNIQUE (tenant_id, identifier)
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  author_user_id text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz
);

CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  invocation_source text NOT NULL DEFAULT 'on_demand',
  trigger_detail text,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  usage_json jsonb,
  result_json jsonb,
  session_id_before text,
  session_id_after text,
  log_store text,
  log_ref text,
  log_bytes bigint,
  log_sha256 text,
  stdout_excerpt text,
  stderr_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_id text,
  source_import_batch_id text,
  source_imported_at timestamptz
);

CREATE TABLE IF NOT EXISTS heartbeat_run_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS issue_close_gates (
  issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  verification_command text,
  required_comment_min_chars integer NOT NULL DEFAULT 80,
  require_changed_files boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_agents_company ON agents(tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues(tenant_id, company_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(tenant_id, assignee_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(tenant_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_issues_origin ON issues(tenant_id, origin_kind, origin_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON issue_comments(tenant_id, issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_agent_status ON heartbeat_runs(tenant_id, agent_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON heartbeat_runs(tenant_id, issue_id);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON heartbeat_run_events(run_id, sequence);
`;

export const CORE_EXECUTION_TABLES = [
  "tenants",
  "companies",
  "projects",
  "agents",
  "issues",
  "issue_comments",
  "heartbeat_runs",
  "heartbeat_run_events",
  "issue_close_gates",
] as const;
