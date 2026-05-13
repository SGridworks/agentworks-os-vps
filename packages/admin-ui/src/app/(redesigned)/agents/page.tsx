'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { StatusDot, relTime, statusKind } from '@/components/v2/primitives';
import {
  listTenants,
  listCompanies,
  listAgents,
  createAgent,
  patchAgent,
  resumeAgent,
  wakeAgent,
  getLanes,
  previewLaneMatch,
  type ExecutionAgent,
  type ExecutionCompany,
  type Tenant,
  type LaneConfig,
  type LaneMatchResult,
} from '@/lib/api';
import { Plus, Zap, Pause, Play, Pencil, X, Save, ChevronDown, ChevronRight } from 'lucide-react';

type StatusFilter = 'all' | 'active' | 'paused' | 'retired';

interface CreateForm {
  name: string;
  role: string;
  companyId: string;
  adapterType: string;
  model: string;
  instructionsPath: string;
}

interface EditForm {
  name: string;
  role: string;
  status: 'active' | 'paused' | 'retired';
  adapterType: string;
  model: string;
  instructionsPath: string;
  capabilities: string;
  heartbeatIntervalSec: string;
  wakeOnDemand: boolean;
  budgetMonthlyCents: string;
}

const EMPTY_CREATE: CreateForm = {
  name: '',
  role: '',
  companyId: '',
  adapterType: '',
  model: '',
  instructionsPath: '',
};

function emptyEdit(a: ExecutionAgent): EditForm {
  return {
    name: a.name,
    role: a.role ?? '',
    status: (a.status as EditForm['status']) ?? 'active',
    adapterType: a.adapterType ?? '',
    model: a.model ?? '',
    instructionsPath: a.instructionsPath ?? '',
    capabilities: a.capabilities ?? '',
    heartbeatIntervalSec: a.heartbeatIntervalSec === null ? '' : String(a.heartbeatIntervalSec),
    wakeOnDemand: a.wakeOnDemand === true,
    budgetMonthlyCents: String(a.budgetMonthlyCents ?? 0),
  };
}

export default function AgentsV2() {
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [companies, setCompanies] = useState<ExecutionCompany[]>([]);
  const [agents, setAgents] = useState<ExecutionAgent[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE);
  const [editing, setEditing] = useState<{ agent: ExecutionAgent; form: EditForm } | null>(null);
  const [lanes, setLanes] = useState<LaneConfig | null>(null);
  const [showLanes, setShowLanes] = useState(false);
  const [lanePreviewInput, setLanePreviewInput] = useState('');
  const [lanePreviewResult, setLanePreviewResult] = useState<LaneMatchResult | null>(null);
  const [lanePreviewBusy, setLanePreviewBusy] = useState(false);

  useEffect(() => {
    listTenants()
      .then((ts) => setTenant(ts[0] ?? null))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!tenant) return;
    listCompanies(tenant.id)
      .then(setCompanies)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load companies'));
  }, [tenant]);

  async function loadLanes() {
    try {
      const cfg = await getLanes();
      setLanes(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load lane config');
    }
  }

  async function runLanePreview() {
    const text = lanePreviewInput.trim();
    if (!text) return;
    setLanePreviewBusy(true);
    try {
      const r = await previewLaneMatch(text);
      setLanePreviewResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lane preview failed');
    } finally {
      setLanePreviewBusy(false);
    }
  }

  async function load() {
    if (!tenant) return;
    try {
      const items = await listAgents({
        tenantId: tenant.id,
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 500,
      });
      setAgents(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, statusFilter]);

  const counts = useMemo(() => {
    const acc = { active: 0, paused: 0, retired: 0 };
    for (const a of agents) {
      if (a.status === 'active') acc.active++;
      else if (a.status === 'paused') acc.paused++;
      else if (a.status === 'retired') acc.retired++;
    }
    return acc;
  }, [agents]);

  const companyName = useMemo(() => {
    const map = new Map<string, string>();
    companies.forEach((c) => map.set(c.id, c.name));
    return map;
  }, [companies]);

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (companyFilter !== 'all' && a.companyId !== companyFilter) return false;
      if (!q) return true;
      const haystack = [
        a.name,
        a.role ?? '',
        a.model ?? '',
        a.adapterType ?? '',
        companyName.get(a.companyId) ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [agents, companyFilter, search, companyName]);

  async function doWake(a: ExecutionAgent) {
    setBusy(a.id);
    try {
      await wakeAgent(a.id, { source: 'admin-ui', reason: 'manual wake from agents page' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wake failed');
    } finally {
      setBusy(null);
    }
  }

  async function doPause(a: ExecutionAgent) {
    setBusy(a.id);
    try {
      await patchAgent(a.id, { status: 'paused', pauseReason: 'paused from admin UI', actorKind: 'operator' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pause failed');
    } finally {
      setBusy(null);
    }
  }

  async function doResume(a: ExecutionAgent) {
    setBusy(a.id);
    try {
      await resumeAgent(a.id, { actorKind: 'operator', source: 'admin-ui' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed');
    } finally {
      setBusy(null);
    }
  }

  async function submitCreate() {
    if (!tenant || !createForm.name.trim()) return;
    setBusy('create');
    try {
      const config: Record<string, unknown> = {};
      if (createForm.adapterType) config.adapterType = createForm.adapterType;
      if (createForm.model) config.model = createForm.model;
      if (createForm.instructionsPath) config.instructionsPath = createForm.instructionsPath;

      await createAgent({
        tenantId: tenant.id,
        companyId: createForm.companyId || undefined,
        name: createForm.name.trim(),
        role: createForm.role.trim() || undefined,
        config: Object.keys(config).length > 0 ? config : undefined,
      });
      setShowCreate(false);
      setCreateForm(EMPTY_CREATE);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(null);
    }
  }

  async function submitEdit() {
    if (!editing) return;
    const { agent, form } = editing;
    setBusy(agent.id);
    try {
      const heartbeatStr = form.heartbeatIntervalSec.trim();
      const heartbeatVal = heartbeatStr === '' ? null : Number(heartbeatStr);
      if (heartbeatStr !== '' && (!Number.isFinite(heartbeatVal) || (heartbeatVal as number) < 0)) {
        throw new Error('Heartbeat interval must be a non-negative number');
      }
      const budgetVal = Number(form.budgetMonthlyCents);
      if (!Number.isFinite(budgetVal) || budgetVal < 0) {
        throw new Error('Budget must be a non-negative number');
      }
      await patchAgent(agent.id, {
        name: form.name.trim(),
        role: form.role.trim() || null,
        status: form.status,
        adapterType: form.adapterType.trim() || null,
        model: form.model.trim() || null,
        instructionsPath: form.instructionsPath.trim() || null,
        capabilities: form.capabilities.trim() || null,
        heartbeatIntervalSec: heartbeatVal as number | null,
        wakeOnDemand: form.wakeOnDemand,
        budgetMonthlyCents: Math.trunc(budgetVal),
        actorKind: 'operator',
        source: 'admin-ui',
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <V2Shell active="agents" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18 }}>
          <div>
            <div className="eyebrow">OPERATE · AGENTS</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Roster &amp; runtime
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
              Every agent registered with the substrate. Configure model and heartbeat,
              wake them on demand, pause when needed, resume from error.
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              setCreateForm({ ...EMPTY_CREATE, companyId: companies[0]?.id ?? '' });
              setShowCreate(true);
            }}
          >
            <Plus size={13} strokeWidth={1.6} />
            New agent
          </button>
        </div>

        {error && (
          <div className="card" style={{ padding: '10px 14px', borderColor: 'var(--err)', color: 'var(--err)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="eyebrow" style={{ margin: 0 }}>FILTER</span>
          {(['all', 'active', 'paused', 'retired'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s}
              {s !== 'all' && <span className="mono" style={{ marginLeft: 6, color: 'var(--ink-3)' }}>{counts[s]}</span>}
            </button>
          ))}
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="mono"
            style={{
              fontSize: 12,
              padding: '4px 8px',
              background: 'var(--bg-2)',
              color: 'var(--ink)',
              border: '1px solid var(--rule)',
              borderRadius: 2,
              marginLeft: 8,
            }}
          >
            <option value="all">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, role, model…"
            className="mono"
            style={{
              flex: 1,
              minWidth: 180,
              maxWidth: 320,
              fontSize: 12,
              padding: '4px 8px',
              background: 'var(--bg-2)',
              color: 'var(--ink)',
              border: '1px solid var(--rule)',
              borderRadius: 2,
            }}
          />
          {(companyFilter !== 'all' || search.trim()) && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setCompanyFilter('all');
                setSearch('');
              }}
            >
              Clear
            </button>
          )}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)' }}>
            <div className="eyebrow" style={{ margin: 0 }}>
              AGENTS · {filteredAgents.length}
              {filteredAgents.length !== agents.length && (
                <span className="mono" style={{ marginLeft: 8, color: 'var(--ink-3)', fontWeight: 400 }}>
                  of {agents.length}
                </span>
              )}
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Status</th>
                <th>Name</th>
                <th>Role</th>
                <th>Company</th>
                <th>Model</th>
                <th style={{ width: 110 }}>Heartbeat</th>
                <th style={{ width: 110 }}>Last seen</th>
                <th style={{ width: 230 }} />
              </tr>
            </thead>
            <tbody>
              {filteredAgents.map((a) => {
                const isPaused = a.status === 'paused';
                const isRetired = a.status === 'retired';
                const inErrorRecovery = isPaused && a.pauseReason !== null;
                return (
                  <tr key={a.id}>
                    <td>
                      <StatusDot kind={statusKind(a.status)} pulse={a.status === 'active'} label={a.status} />
                    </td>
                    <td style={{ fontWeight: 500 }}>
                      <Link href={`/agents/${a.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {a.name}
                      </Link>
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12 }}>{a.role ?? '—'}</td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12 }}>{companyName.get(a.companyId) ?? '—'}</td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{a.model ?? '—'}</td>
                    <td className="mono tabular" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      {a.heartbeatIntervalSec ? `${a.heartbeatIntervalSec}s` : '—'}
                    </td>
                    <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{relTime(a.lastHeartbeatAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-sm"
                          disabled={isRetired || busy === a.id}
                          onClick={() => doWake(a)}
                          title="Wake the agent"
                        >
                          <Zap size={12} strokeWidth={1.6} /> Wake
                        </button>
                        {isPaused ? (
                          <button
                            className="btn btn-sm"
                            disabled={busy === a.id}
                            onClick={() => doResume(a)}
                            title={inErrorRecovery ? 'Resume from pause' : 'Resume'}
                          >
                            <Play size={12} strokeWidth={1.6} /> Resume
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm"
                            disabled={isRetired || busy === a.id}
                            onClick={() => doPause(a)}
                            title="Pause the agent"
                          >
                            <Pause size={12} strokeWidth={1.6} /> Pause
                          </button>
                        )}
                        <button
                          className="btn btn-sm"
                          disabled={busy === a.id}
                          onClick={() => setEditing({ agent: a, form: emptyEdit(a) })}
                          title="Edit agent config"
                        >
                          <Pencil size={12} strokeWidth={1.6} /> Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {agents.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    {tenant ? 'No agents yet. Create one to get started.' : 'Loading tenant…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <button
            onClick={() => {
              const next = !showLanes;
              setShowLanes(next);
              if (next && !lanes) void loadLanes();
            }}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '12px 16px',
              borderBottom: showLanes ? '1px solid var(--rule)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
            }}
          >
            {showLanes ? <ChevronDown size={14} strokeWidth={1.6} /> : <ChevronRight size={14} strokeWidth={1.6} />}
            <span className="eyebrow" style={{ margin: 0 }}>LANES · file routing</span>
            {lanes && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-3)' }}>{lanes.roles.length} roles</span>}
          </button>
          {showLanes && (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                File-path → role routing rules. Read-only mirror of <code className="mono" style={{ fontSize: 11 }}>~/.agentworks/scripts/agent-lanes.json</code>.
              </div>
              {!lanes ? (
                <div style={{ fontSize: 12, color: 'var(--ink-4)', fontStyle: 'italic' }}>Loading…</div>
              ) : (
                <>
                  <div className="card" style={{ padding: '8px 12px', background: 'var(--bg-card)' }}>
                    <div className="eyebrow" style={{ margin: '0 0 4px 0' }}>UNIVERSAL ALLOW</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {lanes.universalAllow.map((p) => (
                        <code key={p} className="mono" style={{ fontSize: 11, padding: '2px 6px', border: '1px solid var(--rule-2)', borderRadius: 2 }}>{p}</code>
                      ))}
                    </div>
                  </div>

                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 180 }}>Role</th>
                        <th style={{ width: 110 }}>ID prefix</th>
                        <th>Allow patterns</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lanes.roles.map((r) => (
                        <tr key={r.role}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{r.role}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{r.description}</div>
                          </td>
                          <td className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.agentIdPrefix}</td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {r.allow.map((p) => (
                                <code key={p} className="mono" style={{ fontSize: 10, padding: '1px 5px', border: '1px solid var(--rule-2)', borderRadius: 2 }}>{p}</code>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="card" style={{ padding: '12px 14px', background: 'var(--bg-card)' }}>
                    <div className="eyebrow" style={{ margin: '0 0 8px 0' }}>LANE MATCH PREVIEW</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                      <input
                        className="form-input"
                        placeholder="paste an issue description (paths inside it route)"
                        value={lanePreviewInput}
                        onChange={(e) => setLanePreviewInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && runLanePreview()}
                        style={{ flex: 1 }}
                      />
                      <button className="btn btn-sm btn-primary" onClick={runLanePreview} disabled={lanePreviewBusy || !lanePreviewInput.trim()}>
                        Preview
                      </button>
                    </div>
                    {lanePreviewResult && (
                      <div style={{ marginTop: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                          <span className="eyebrow" style={{ margin: 0 }}>RESULT</span>{' '}
                          {lanePreviewResult.matched ? (
                            <span style={{ color: 'var(--ink)' }}>
                              matched <strong>{lanePreviewResult.role}</strong>{' '}
                              <code className="mono" style={{ fontSize: 11 }}>{lanePreviewResult.agentIdPrefix}</code>
                            </span>
                          ) : (
                            <span style={{ color: 'var(--warn)' }}>
                              {lanePreviewResult.ambiguous ? 'ambiguous' : 'triage'}
                            </span>
                          )}
                        </div>
                        <div style={{ color: 'var(--ink-3)' }}>{lanePreviewResult.reason}</div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <Modal title="New agent" onClose={() => setShowCreate(false)}>
          <FormRow label="Name *">
            <input
              className="form-input"
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              autoFocus
            />
          </FormRow>
          <FormRow label="Role">
            <input
              className="form-input"
              placeholder="e.g. BackendEngineer"
              value={createForm.role}
              onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
            />
          </FormRow>
          <FormRow label="Company">
            <select
              className="form-select"
              value={createForm.companyId}
              onChange={(e) => setCreateForm({ ...createForm, companyId: e.target.value })}
            >
              <option value="">— none —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Adapter type">
            <input
              className="form-input"
              placeholder="e.g. claude_local"
              value={createForm.adapterType}
              onChange={(e) => setCreateForm({ ...createForm, adapterType: e.target.value })}
            />
          </FormRow>
          <FormRow label="Model">
            <input
              className="form-input"
              placeholder="e.g. kimi-k2-turbo-preview"
              value={createForm.model}
              onChange={(e) => setCreateForm({ ...createForm, model: e.target.value })}
            />
          </FormRow>
          <FormRow label="Instructions path">
            <input
              className="form-input"
              placeholder="path to AGENTS.md"
              value={createForm.instructionsPath}
              onChange={(e) => setCreateForm({ ...createForm, instructionsPath: e.target.value })}
            />
          </FormRow>
          <ModalActions
            onCancel={() => setShowCreate(false)}
            onConfirm={submitCreate}
            confirmLabel="Create"
            disabled={!createForm.name.trim() || busy === 'create'}
          />
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.agent.name}`} onClose={() => setEditing(null)}>
          <FormRow label="Name">
            <input
              className="form-input"
              value={editing.form.name}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Role">
            <input
              className="form-input"
              value={editing.form.role}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, role: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Status">
            <select
              className="form-select"
              value={editing.form.status}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, status: e.target.value as EditForm['status'] } })}
            >
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="retired">retired</option>
            </select>
          </FormRow>
          <FormRow label="Adapter type">
            <input
              className="form-input"
              value={editing.form.adapterType}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, adapterType: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Model">
            <input
              className="form-input"
              value={editing.form.model}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, model: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Instructions path">
            <input
              className="form-input"
              value={editing.form.instructionsPath}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, instructionsPath: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Capabilities">
            <input
              className="form-input"
              value={editing.form.capabilities}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, capabilities: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Heartbeat interval (s)">
            <input
              className="form-input"
              type="number"
              min={0}
              value={editing.form.heartbeatIntervalSec}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, heartbeatIntervalSec: e.target.value } })}
            />
          </FormRow>
          <FormRow label="Wake on demand">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={editing.form.wakeOnDemand}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, wakeOnDemand: e.target.checked } })}
              />
              Allow wake-on-demand
            </label>
          </FormRow>
          <FormRow label="Monthly budget (cents)">
            <input
              className="form-input"
              type="number"
              min={0}
              value={editing.form.budgetMonthlyCents}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, budgetMonthlyCents: e.target.value } })}
            />
          </FormRow>
          <ModalActions
            onCancel={() => setEditing(null)}
            onConfirm={submitEdit}
            confirmLabel="Save"
            confirmIcon={<Save size={12} strokeWidth={1.6} />}
            disabled={!editing.form.name.trim() || busy === editing.agent.id}
          />
        </Modal>
      )}
    </V2Shell>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      <span className="eyebrow" style={{ margin: 0 }}>{label}</span>
      {children}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 480, maxHeight: '90vh', overflow: 'auto', padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="serif" style={{ fontSize: 18 }}>{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalActions({
  onCancel,
  onConfirm,
  confirmLabel,
  confirmIcon,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmIcon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
      <button className="btn" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary" onClick={onConfirm} disabled={disabled}>
        {confirmIcon}
        {confirmLabel}
      </button>
    </div>
  );
}
