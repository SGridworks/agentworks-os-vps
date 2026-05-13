'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { StatusDot, relTime, fmtMoney, statusKind } from '@/components/v2/primitives';
import {
  getAgent,
  getAgentRuntimeState,
  listAgentRevisions,
  listAgentWakeups,
  listAgentTaskSessions,
  getAgentInboxLite,
  getAgentInstructions,
  putAgentInstructions,
  patchAgent,
  resumeAgent,
  wakeAgent,
  type AgentInstructions,
  type ExecutionAgent,
  type ExecutionAgentRuntimeState,
  type ExecutionAgentRevision,
  type ExecutionAgentWakeup,
  type ExecutionAgentTaskSession,
  type InboxLiteIssue,
} from '@/lib/api';
import { ArrowLeft, Pause, Play, Zap, RefreshCw, Pencil, X, Save } from 'lucide-react';
import { Card, KV, KVInput, KVSelect, Empty, ExpandableRows, prioColor } from './parts';

type ConfigDraft = {
  name: string;
  role: string;
  adapterType: string;
  model: string;
  instructionsPath: string;
  capabilities: string;
  heartbeatIntervalSec: string;
  wakeOnDemand: 'inherit' | 'yes' | 'no';
  reportsTo: string;
  budgetMonthlyCents: string;
};

function draftFrom(a: ExecutionAgent): ConfigDraft {
  return {
    name: a.name,
    role: a.role ?? '',
    adapterType: a.adapterType ?? '',
    model: a.model ?? '',
    instructionsPath: a.instructionsPath ?? '',
    capabilities: a.capabilities ?? '',
    heartbeatIntervalSec: a.heartbeatIntervalSec == null ? '' : String(a.heartbeatIntervalSec),
    wakeOnDemand: a.wakeOnDemand === true ? 'yes' : a.wakeOnDemand === false ? 'no' : 'inherit',
    reportsTo: a.reportsTo ?? '',
    budgetMonthlyCents: String(a.budgetMonthlyCents ?? 0),
  };
}

export default function AgentDetailV2() {
  const navigate = useV2Nav();
  const params = useParams<{ id: string }>();
  const agentId = params?.id ?? '';

  const [agent, setAgent] = useState<ExecutionAgent | null>(null);
  const [runtimeState, setRuntimeState] = useState<ExecutionAgentRuntimeState | null>(null);
  const [revisions, setRevisions] = useState<ExecutionAgentRevision[]>([]);
  const [wakeups, setWakeups] = useState<ExecutionAgentWakeup[]>([]);
  const [taskSessions, setTaskSessions] = useState<ExecutionAgentTaskSession[]>([]);
  const [inbox, setInbox] = useState<InboxLiteIssue[]>([]);
  const [instructions, setInstructions] = useState<AgentInstructions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingConfig, setEditingConfig] = useState(false);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [editingInstr, setEditingInstr] = useState(false);
  const [instrDraft, setInstrDraft] = useState('');

  async function load() {
    if (!agentId) return;
    try {
      const [a, rs, revs, wks, sess, instr] = await Promise.all([
        getAgent(agentId),
        getAgentRuntimeState(agentId).catch(() => null),
        listAgentRevisions(agentId, 25).catch(() => []),
        listAgentWakeups(agentId, 25).catch(() => []),
        listAgentTaskSessions(agentId).catch(() => []),
        getAgentInstructions(agentId).catch(() => null),
      ]);
      setAgent(a);
      setRuntimeState(rs);
      setRevisions(revs);
      setWakeups(wks);
      setTaskSessions(sess);
      setInstructions(instr);
      // Inbox-lite needs companyId — fetch only after we have the agent.
      if (a.companyId) {
        try {
          const inboxItems = await getAgentInboxLite(agentId, a.companyId);
          setInbox(inboxItems);
        } catch {
          setInbox([]);
        }
      } else {
        setInbox([]);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agent');
    }
  }

  function startEditConfig() {
    if (!agent) return;
    setDraft(draftFrom(agent));
    setEditingConfig(true);
  }

  async function saveConfig() {
    if (!agent || !draft) return;
    const heartbeat = draft.heartbeatIntervalSec.trim();
    const budget = draft.budgetMonthlyCents.trim();
    setBusy(true);
    try {
      await patchAgent(agent.id, {
        name: draft.name.trim() || agent.name,
        role: draft.role.trim() === '' ? null : draft.role.trim(),
        adapterType: draft.adapterType.trim() === '' ? null : draft.adapterType.trim(),
        model: draft.model.trim() === '' ? null : draft.model.trim(),
        instructionsPath: draft.instructionsPath.trim() === '' ? null : draft.instructionsPath.trim(),
        capabilities: draft.capabilities.trim() === '' ? null : draft.capabilities.trim(),
        heartbeatIntervalSec: heartbeat === '' ? null : Number(heartbeat),
        wakeOnDemand: draft.wakeOnDemand === 'yes' ? true : draft.wakeOnDemand === 'no' ? false : null,
        reportsTo: draft.reportsTo.trim() === '' ? null : draft.reportsTo.trim(),
        budgetMonthlyCents: budget === '' ? 0 : Number(budget),
        actorKind: 'operator',
        source: 'admin-ui',
      });
      setEditingConfig(false);
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  function startEditInstructions() {
    setInstrDraft(instructions?.content ?? '');
    setEditingInstr(true);
  }

  async function saveInstructions() {
    if (!agent) return;
    setBusy(true);
    try {
      await putAgentInstructions(agent.id, instrDraft);
      setEditingInstr(false);
      const fresh = await getAgentInstructions(agent.id);
      setInstructions(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <V2Shell active="agents" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div>
          <Link
            href="/agents"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--ink-3)',
              textDecoration: 'none',
            }}
          >
            <ArrowLeft size={12} strokeWidth={1.6} /> Back to agents
          </Link>
        </div>

        {error && (
          <div className="card" style={{ padding: '10px 14px', borderColor: 'var(--err)', color: 'var(--err)', fontSize: 13 }}>
            {error}
          </div>
        )}

        {!agent ? (
          <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18 }}>
              <div>
                <div className="eyebrow">OPERATE · AGENT</div>
                <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
                  {agent.name}
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center', fontSize: 13, color: 'var(--ink-3)' }}>
                  <StatusDot kind={statusKind(agent.status)} pulse={agent.status === 'active'} label={agent.status} />
                  {agent.role && <span>{agent.role}</span>}
                  {agent.model && <span className="mono" style={{ fontSize: 11 }}>{agent.model}</span>}
                  <span>id <code className="mono" style={{ fontSize: 11 }}>{agent.id.slice(0, 8)}</code></span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-sm" onClick={() => action(() => wakeAgent(agent.id, { source: 'admin-ui' }))} disabled={busy || agent.status === 'retired'}>
                  <Zap size={12} strokeWidth={1.6} /> Wake
                </button>
                {agent.status === 'paused' ? (
                  <button className="btn btn-sm" onClick={() => action(() => resumeAgent(agent.id, { actorKind: 'operator', source: 'admin-ui' }))} disabled={busy}>
                    <Play size={12} strokeWidth={1.6} /> Resume
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={() => action(() => patchAgent(agent.id, { status: 'paused', pauseReason: 'paused from detail page', actorKind: 'operator' }))} disabled={busy || agent.status === 'retired'}>
                    <Pause size={12} strokeWidth={1.6} /> Pause
                  </button>
                )}
                <button className="btn btn-sm" onClick={load} disabled={busy} title="Refresh">
                  <RefreshCw size={12} strokeWidth={1.6} />
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
              <Card
                title="Configuration"
                action={
                  editingConfig ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => { setEditingConfig(false); setDraft(null); }} disabled={busy}>
                        <X size={12} strokeWidth={1.6} /> Cancel
                      </button>
                      <button className="btn btn-sm btn-primary" onClick={saveConfig} disabled={busy}>
                        <Save size={12} strokeWidth={1.6} /> Save
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn-sm" onClick={startEditConfig} disabled={busy}>
                      <Pencil size={12} strokeWidth={1.6} /> Edit
                    </button>
                  )
                }
              >
                {editingConfig && draft ? (
                  <>
                    <KVInput k="Name" v={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                    <KVInput k="Role" v={draft.role} onChange={(v) => setDraft({ ...draft, role: v })} />
                    <KVInput k="Adapter" v={draft.adapterType} onChange={(v) => setDraft({ ...draft, adapterType: v })} mono />
                    <KVInput k="Model" v={draft.model} onChange={(v) => setDraft({ ...draft, model: v })} mono />
                    <KVInput k="Instructions" v={draft.instructionsPath} onChange={(v) => setDraft({ ...draft, instructionsPath: v })} mono placeholder="ceo/AGENTS.md" />
                    <KVInput k="Heartbeat (s)" v={draft.heartbeatIntervalSec} onChange={(v) => setDraft({ ...draft, heartbeatIntervalSec: v })} mono inputMode="numeric" />
                    <KVSelect
                      k="Wake on demand"
                      v={draft.wakeOnDemand}
                      onChange={(v) => setDraft({ ...draft, wakeOnDemand: v as ConfigDraft['wakeOnDemand'] })}
                      options={[
                        { value: 'inherit', label: 'inherit' },
                        { value: 'yes', label: 'yes' },
                        { value: 'no', label: 'no' },
                      ]}
                    />
                    <KVInput k="Reports to" v={draft.reportsTo} onChange={(v) => setDraft({ ...draft, reportsTo: v })} mono placeholder="agent uuid" />
                    <KVInput k="Capabilities" v={draft.capabilities} onChange={(v) => setDraft({ ...draft, capabilities: v })} />
                    <KVInput k="Budget (¢/mo)" v={draft.budgetMonthlyCents} onChange={(v) => setDraft({ ...draft, budgetMonthlyCents: v })} mono inputMode="numeric" />
                  </>
                ) : (
                  <>
                    <KV k="Adapter" v={agent.adapterType ?? '—'} />
                    <KV k="Model" v={agent.model ?? '—'} mono />
                    <KV k="Instructions" v={agent.instructionsPath ?? '—'} mono />
                    <KV k="Heartbeat" v={agent.heartbeatIntervalSec ? `${agent.heartbeatIntervalSec}s` : '—'} />
                    <KV k="Wake on demand" v={agent.wakeOnDemand === null ? '—' : agent.wakeOnDemand ? 'yes' : 'no'} />
                    <KV k="Reports to" v={agent.reportsTo ?? '—'} mono />
                    <KV k="Capabilities" v={agent.capabilities ?? '—'} />
                  </>
                )}
              </Card>

              <Card title="Runtime state">
                {runtimeState ? (
                  <>
                    <KV k="Last run" v={runtimeState.lastRunStatus ?? '—'} />
                    <KV k="Last run at" v={relTime(runtimeState.lastRunAt)} />
                    <KV k="Session" v={runtimeState.sessionId ?? '—'} mono />
                    <KV k="Input tokens" v={runtimeState.totalInputTokens.toLocaleString()} mono />
                    <KV k="Output tokens" v={runtimeState.totalOutputTokens.toLocaleString()} mono />
                    <KV k="Cached input" v={runtimeState.totalCachedInputTokens.toLocaleString()} mono />
                    <KV k="Total cost" v={fmtMoney(runtimeState.totalCostCents)} mono />
                    {runtimeState.lastError && (
                      <KV k="Last error" v={runtimeState.lastError} valueColor="var(--err)" />
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    No heartbeat yet
                  </div>
                )}
              </Card>

              <Card title="Budget &amp; activity">
                <KV k="Last heartbeat" v={relTime(agent.lastHeartbeatAt)} />
                <KV k="Monthly budget" v={fmtMoney(agent.budgetMonthlyCents)} mono />
                <KV k="Spent this month" v={fmtMoney(agent.spentMonthlyCents)} mono />
                <KV k="Period start" v={agent.budgetPeriodStart ?? '—'} />
                <KV k="Pause reason" v={agent.pauseReason ?? '—'} />
                <KV k="Paused at" v={agent.pausedAt ? relTime(agent.pausedAt) : '—'} />
              </Card>
            </div>

            <Card
              title={`Instructions${instructions?.instructionsPath ? ` · ${instructions.instructionsPath}` : ''}`}
              action={
                editingInstr ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => setEditingInstr(false)} disabled={busy}>
                      <X size={12} strokeWidth={1.6} /> Cancel
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={saveInstructions} disabled={busy}>
                      <Save size={12} strokeWidth={1.6} /> Save
                    </button>
                  </div>
                ) : instructions?.instructionsPath ? (
                  <button className="btn btn-sm" onClick={startEditInstructions} disabled={busy}>
                    <Pencil size={12} strokeWidth={1.6} /> Edit
                  </button>
                ) : null
              }
            >
              {!instructions?.instructionsPath ? (
                <Empty>
                  No instructions path set. Use Edit on Configuration to set one
                  (e.g. <code className="mono">{agent.role || 'role'}/AGENTS.md</code>).
                </Empty>
              ) : editingInstr ? (
                <textarea
                  value={instrDraft}
                  onChange={(e) => setInstrDraft(e.target.value)}
                  spellCheck={false}
                  style={{
                    width: '100%',
                    minHeight: 360,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    lineHeight: 1.5,
                    padding: 12,
                    border: '1px solid var(--rule)',
                    background: 'var(--bg-2)',
                    color: 'var(--ink)',
                    borderRadius: 2,
                    resize: 'vertical',
                  }}
                />
              ) : instructions.exists ? (
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: 'var(--ink-2)',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--rule)',
                    borderRadius: 2,
                    maxHeight: 400,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {instructions.content}
                </pre>
              ) : (
                <Empty>File does not exist yet — click Edit to create it.</Empty>
              )}
            </Card>

            <Card title={`Inbox · ${inbox.length}`} flush>
              {inbox.length === 0 ? (
                <Empty>No assigned issues.</Empty>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>ID</th>
                      <th>Title</th>
                      <th style={{ width: 90 }}>Priority</th>
                      <th style={{ width: 90 }}>Status</th>
                      <th style={{ width: 90 }}>Unblocks</th>
                      <th style={{ width: 110 }}>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ExpandableRows
                      items={inbox}
                      noun="issues"
                      renderRow={(i) => (
                        <tr key={i.id}>
                          <td className="mono" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{i.identifier ?? i.id.slice(0, 8)}</td>
                          <td style={{ fontWeight: 500 }}>{i.title}</td>
                          <td>
                            <span className="mono" style={{ fontSize: 10, color: prioColor(i.priority), textTransform: 'uppercase', letterSpacing: '.06em' }}>
                              {i.priority}
                            </span>
                          </td>
                          <td>
                            <StatusDot kind={statusKind(i.status)} label={i.status} />
                          </td>
                          <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{i.unblockCount}</td>
                          <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{relTime(i.createdAt)}</td>
                        </tr>
                      )}
                    />
                  </tbody>
                </table>
              )}
            </Card>

            <Card title={`Revisions · ${revisions.length}`} flush>
              {revisions.length === 0 ? (
                <Empty>No config changes recorded.</Empty>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>When</th>
                      <th>Changed</th>
                      <th style={{ width: 110 }}>Actor</th>
                      <th style={{ width: 110 }}>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ExpandableRows
                      items={revisions}
                      noun="revisions"
                      renderRow={(r) => (
                        <tr key={r.id}>
                          <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{relTime(r.createdAt)}</td>
                          <td>
                            {r.changedKeys.map((k) => (
                              <span key={k} className="mono" style={{ fontSize: 10, padding: '1px 6px', border: '1px solid var(--rule-2)', marginRight: 4, borderRadius: 2 }}>
                                {k}
                              </span>
                            ))}
                          </td>
                          <td className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                            {r.actorKind}{r.actorId ? ` · ${r.actorId}` : ''}
                          </td>
                          <td className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.source ?? '—'}</td>
                        </tr>
                      )}
                    />
                  </tbody>
                </table>
              )}
            </Card>

            <Card title={`Wakeups · ${wakeups.length}`} flush>
              {wakeups.length === 0 ? (
                <Empty>No wakeups recorded.</Empty>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>When</th>
                      <th style={{ width: 120 }}>Source</th>
                      <th>Reason</th>
                      <th style={{ width: 110 }}>Coalesced</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ExpandableRows
                      items={wakeups}
                      noun="wakeups"
                      renderRow={(w) => (
                        <tr key={w.id}>
                          <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{relTime(w.createdAt)}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{w.source ?? '—'}</td>
                          <td style={{ fontSize: 12 }}>{w.reason ?? '—'}</td>
                          <td className="mono tabular">{w.coalescedCount}</td>
                        </tr>
                      )}
                    />
                  </tbody>
                </table>
              )}
            </Card>

            <Card title={`Task sessions · ${taskSessions.length}`} flush>
              {taskSessions.length === 0 ? (
                <Empty>No active sessions.</Empty>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>Updated</th>
                      <th>Task key</th>
                      <th style={{ width: 100 }}>Status</th>
                      <th style={{ width: 140 }}>Adapter</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ExpandableRows
                      items={taskSessions}
                      noun="sessions"
                      renderRow={(s) => (
                        <tr key={s.id}>
                          <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{relTime(s.updatedAt)}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.taskKey}</td>
                          <td>
                            <StatusDot kind={statusKind(s.status)} label={s.status} />
                          </td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.adapterType ?? '—'}</td>
                        </tr>
                      )}
                    />
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}
      </div>
    </V2Shell>
  );
}

