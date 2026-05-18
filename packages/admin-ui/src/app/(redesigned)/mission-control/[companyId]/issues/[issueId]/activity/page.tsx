'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertTriangle, ArrowLeft, Clock, RefreshCw, Radio, Terminal } from 'lucide-react';
import {
  listTenants,
  listCompanies,
  listCompanyAgents,
  listCompanyIssues,
  listDispatchQueue,
  listIssueComments,
  type DispatchQueueRow,
  type ExecutionAgent,
  type ExecutionCompany,
  type ExecutionIssue,
  type IssueComment,
} from '@/lib/api';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { StatusDot, StatusPill, relTime, statusKind, type StatusKind } from '@/components/v2/primitives';

const POLL_MS = 2000;
const DISPATCH_LIMIT = 200;

interface PageState {
  company: ExecutionCompany | null;
  agents: ExecutionAgent[];
  issue: ExecutionIssue | null;
  dispatches: DispatchQueueRow[];
  comments: IssueComment[];
  totalDispatches: number;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
}

export default function IssueActivityPage({
  params,
}: {
  params: { companyId: string; issueId: string };
}) {
  const router = useRouter();
  const navigate = useV2Nav();
  const [state, setState] = useState<PageState>({
    company: null,
    agents: [],
    issue: null,
    dispatches: [],
    comments: [],
    totalDispatches: 0,
    loading: true,
    error: null,
    lastUpdatedAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const tenants = await listTenants();
        const tenant = tenants[0];
        if (!tenant) {
          if (!cancelled) {
            setState((prev) => ({
              ...prev,
              loading: false,
              error: 'No tenants registered.',
              lastUpdatedAt: new Date().toISOString(),
            }));
          }
          return;
        }

        const [companies, agents, issues, comments, dispatchPage] = await Promise.all([
          listCompanies(tenant.id),
          listCompanyAgents(params.companyId),
          listCompanyIssues(params.companyId),
          listIssueComments(params.issueId, 50).catch(() => [] as IssueComment[]),
          listDispatchQueue({ tenantId: tenant.id, limit: DISPATCH_LIMIT }),
        ]);

        const company = companies.find((c) => c.id === params.companyId) ?? null;
        const issue = issues.find((i) => i.id === params.issueId) ?? null;
        const dispatches = dispatchPage.items.filter((row) => dispatchMatchesIssue(row, params.issueId));

        if (!cancelled) {
          setState({
            company,
            agents,
            issue,
            dispatches,
            comments,
            totalDispatches: dispatchPage.total,
            loading: false,
            error: null,
            lastUpdatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: String(err),
            lastUpdatedAt: new Date().toISOString(),
          }));
        }
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [params.companyId, params.issueId]);

  const assignee = state.issue?.assigneeAgentId
    ? state.agents.find((a) => a.id === state.issue?.assigneeAgentId) ?? null
    : null;
  const activeDispatch = useMemo(
    () => state.dispatches.find((row) => row.status === 'queued' || row.status === 'dispatched') ?? null,
    [state.dispatches],
  );
  const displayDispatch = activeDispatch ?? state.dispatches[0] ?? null;
  const liveStatusKind = displayDispatch ? dispatchStatusKind(displayDispatch.status) : 'muted';
  const staleInProgress =
    state.issue?.status === 'in_progress' && !activeDispatch && !state.loading && state.dispatches.length > 0;
  const noDispatchFound =
    state.issue?.status === 'in_progress' && !activeDispatch && !state.loading && state.dispatches.length === 0;

  return (
    <V2Shell
      active="mission-control"
      onNav={navigate}
      tenant={{
        mark: state.company ? state.company.name.slice(0, 2).toUpperCase() : '..',
        name: state.company?.name ?? 'Loading...',
      }}
      triageCount={0}
    >
      <div className="poll-bar" />

      <div className="pageheader" style={{ paddingBottom: 14, borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <button
            className="icon-btn"
            onClick={() => router.push(`/mission-control/${params.companyId}`)}
            aria-label="Back to company board"
            style={{ border: '1px solid var(--rule-2)' }}
          >
            <ArrowLeft size={14} strokeWidth={1.6} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              MISSION CONTROL - LIVE ISSUE ACTIVITY
            </div>
            <h1 className="pageheader-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusDot kind={liveStatusKind} pulse={Boolean(activeDispatch)} size={8} />
              {state.issue?.identifier ?? 'Issue'}: {state.issue?.title ?? 'Loading...'}
            </h1>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            POLLING - 2s
          </span>
          <StatusPill kind={liveStatusKind}>{displayDispatch?.status ?? state.issue?.status ?? 'loading'}</StatusPill>
          <button
            className="btn"
            onClick={() => router.refresh()}
            title="Refresh route shell"
          >
            <RefreshCw size={13} strokeWidth={1.6} />Refresh
          </button>
        </div>
      </div>

      {state.error && (
        <div style={{ margin: '12px 28px' }}>
          <StatusPill kind="error">{state.error}</StatusPill>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 0.9fr) minmax(420px, 1.4fr)',
          gap: 18,
          padding: 24,
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="card" style={{ padding: 0 }}>
            <PanelHeader icon={<Radio size={14} strokeWidth={1.6} />} label="LIVE DISPATCH" />
            <div style={{ padding: 18, display: 'grid', gap: 14 }}>
              {displayDispatch ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 4 }}>
                        {activeDispatch ? displayDispatch.taskKind : `Latest: ${displayDispatch.taskKind}`}
                      </div>
                      <div className="serif" style={{ fontSize: 30, color: 'var(--ink)' }}>
                        {formatElapsed(displayDispatch.dispatchedAt ?? displayDispatch.createdAt)}
                      </div>
                    </div>
                    <StatusPill kind={dispatchStatusKind(displayDispatch.status)}>{displayDispatch.status}</StatusPill>
                  </div>
                  <KvRow label="Agent" value={agentName(state.agents, displayDispatch.targetAgentId)} />
                  <KvRow label="Dispatch" value={shortId(displayDispatch.id)} />
                  <KvRow label="Created" value={relTime(displayDispatch.createdAt)} />
                  <KvRow label="Dispatched" value={relTime(displayDispatch.dispatchedAt)} />
                  {displayDispatch.completedAt && <KvRow label="Completed" value={relTime(displayDispatch.completedAt)} />}
                  {displayDispatch.error && <KvRow label="Error" value={displayDispatch.error} tone="error" />}
                  {(() => {
                    const executionPath = getRecordValue(displayDispatch.input, ['source']);
                    const effectiveModel = getRecordValue(displayDispatch.input, ['model']);
                    return (
                      <>
                        {typeof executionPath === 'string' && (
                          <KvRow label="Execution Path" value={executionPath} />
                        )}
                        {typeof effectiveModel === 'string' && (
                          <KvRow label="Effective Model" value={effectiveModel} />
                        )}
                      </>
                    );
                  })()}
                  <InputPreview input={displayDispatch.input} />
                </>
              ) : (
                <EmptyLiveState
                  loading={state.loading}
                  hasIssue={Boolean(state.issue)}
                  staleInProgress={staleInProgress}
                  noDispatchFound={noDispatchFound}
                />
              )}
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <PanelHeader icon={<Activity size={14} strokeWidth={1.6} />} label="ISSUE CONTEXT" />
            <div style={{ padding: 18, display: 'grid', gap: 10 }}>
              <KvRow label="Status" value={state.issue?.status?.replace('_', ' ') ?? 'Loading'} />
              <KvRow label="Priority" value={state.issue?.priority ?? '-'} />
              <KvRow label="Assignee" value={assignee?.name ?? 'Unassigned'} />
              <KvRow label="Updated" value={relTime(state.issue?.updatedAt)} />
              <KvRow label="Dispatch page" value={`${state.totalDispatches} rows scanned by newest ${DISPATCH_LIMIT}`} />
              {state.issue?.description && (
                <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>DESCRIPTION</div>
                  <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                    {state.issue.description}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="card" style={{ padding: 0 }}>
            <PanelHeader icon={<Clock size={14} strokeWidth={1.6} />} label={`DISPATCH TIMELINE - ${state.dispatches.length}`} />
            <div style={{ padding: '4px 0' }}>
              {state.dispatches.length > 0 ? (
                state.dispatches.map((row, index) => (
                  <DispatchTimelineRow
                    key={row.id}
                    row={row}
                    agent={state.agents.find((a) => a.id === row.targetAgentId) ?? null}
                    first={index === 0}
                  />
                ))
              ) : (
                <div className="mono" style={{ padding: 18, fontSize: 12, color: 'var(--ink-4)' }}>
                  {state.loading ? 'Loading dispatch activity...' : 'No dispatch rows found for this issue in the recent queue window.'}
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <PanelHeader icon={<Terminal size={14} strokeWidth={1.6} />} label={`ISSUE COMMENTS - ${state.comments.length}`} />
            <div style={{ padding: 12, display: 'grid', gap: 10, maxHeight: 380, overflowY: 'auto' }}>
              {state.comments.length > 0 ? (
                state.comments.map((comment) => (
                  <div
                    key={comment.id}
                    style={{
                      padding: '10px 12px',
                      background: 'var(--bg-2)',
                      border: '1px solid var(--rule)',
                      borderRadius: 2,
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        fontSize: 10,
                        color: 'var(--ink-3)',
                        letterSpacing: '.06em',
                        textTransform: 'uppercase',
                        marginBottom: 6,
                      }}
                    >
                      <span>{comment.authorLabel}</span>
                      <span>{relTime(comment.createdAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                      {comment.body}
                    </div>
                  </div>
                ))
              ) : (
                <div className="mono" style={{ padding: 6, fontSize: 12, color: 'var(--ink-4)' }}>
                  {state.loading ? 'Loading comments...' : 'No comments posted yet.'}
                </div>
              )}
            </div>
          </div>

          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.04em' }}>
            Last updated {relTime(state.lastUpdatedAt)}
          </div>
        </section>
      </div>
    </V2Shell>
  );
}

function PanelHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div
      className="eyebrow"
      style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--rule)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {icon}
      {label}
    </div>
  );
}

function DispatchTimelineRow({
  row,
  agent,
  first,
}: {
  row: DispatchQueueRow;
  agent: ExecutionAgent | null;
  first: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 110px 1fr 120px',
        gap: 14,
        padding: '10px 14px',
        borderTop: first ? 'none' : '1px solid var(--rule)',
        alignItems: 'center',
      }}
    >
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>{relTime(row.createdAt)}</span>
      <StatusPill kind={dispatchStatusKind(row.status)}>{row.status}</StatusPill>
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agent?.name ?? row.targetAgentId}
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 2 }}>
          {row.taskKind} - {shortId(row.id)}
        </div>
      </div>
      <span className="mono tabular" style={{ fontSize: 12, color: 'var(--ink-2)', textAlign: 'right' }}>
        {formatDuration(row.createdAt, row.completedAt ?? row.dispatchedAt)}
      </span>
      {row.error && (
        <div style={{ gridColumn: '1 / -1', color: 'var(--err)', fontSize: 12, lineHeight: 1.45 }}>
          {row.error}
        </div>
      )}
    </div>
  );
}

function EmptyLiveState({
  loading,
  hasIssue,
  staleInProgress,
  noDispatchFound,
}: {
  loading: boolean;
  hasIssue: boolean;
  staleInProgress: boolean;
  noDispatchFound: boolean;
}) {
  if (loading) {
    return <div className="mono" style={{ fontSize: 12, color: 'var(--ink-4)' }}>Loading live activity...</div>;
  }
  if (!hasIssue) {
    return <Notice kind="error" text="Issue not found in this company." />;
  }
  if (staleInProgress) {
    return <Notice kind="warn" text="No active dispatch is visible. The issue may be waiting on status reconciliation." />;
  }
  if (noDispatchFound) {
    return <Notice kind="warn" text="No recent dispatch rows were found for this in-progress issue." />;
  }
  return <Notice kind="muted" text="No active dispatch is currently running for this issue." />;
}

function Notice({ kind, text }: { kind: StatusKind; text: string }) {
  const color = kind === 'error' ? 'var(--err)' : kind === 'warn' ? 'var(--warn)' : 'var(--ink-3)';
  return (
    <div style={{ display: 'flex', gap: 10, color, fontSize: 13, lineHeight: 1.5 }}>
      <AlertTriangle size={15} strokeWidth={1.6} style={{ flex: '0 0 auto', marginTop: 2 }} />
      <span>{text}</span>
    </div>
  );
}

function KvRow({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
      <span className="mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', textTransform: 'uppercase', fontSize: 10 }}>
        {label}
      </span>
      <span
        className="mono"
        style={{
          color: tone === 'error' ? 'var(--err)' : 'var(--ink-2)',
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '70%',
          fontSize: 12,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function InputPreview({ input }: { input: unknown }) {
  const reason = getRecordValue(input, ['reason']);
  const source = getRecordValue(input, ['source']);
  return (
    <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 12, display: 'grid', gap: 8 }}>
      <div className="eyebrow">INPUT</div>
      {source && <KvRow label="Source" value={source} />}
      {reason && <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45 }}>{reason}</div>}
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 10,
          maxHeight: 180,
          overflow: 'auto',
          background: 'var(--bg-2)',
          border: '1px solid var(--rule)',
          color: 'var(--ink-3)',
          fontSize: 11,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
        }}
      >
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

function dispatchMatchesIssue(row: DispatchQueueRow, issueId: string): boolean {
  const direct = getRecordValue(row.input, ['issueId']);
  const payload = getRecordValue(row.input, ['payload', 'issueId']);
  const context = getRecordValue(row.input, ['contextSnapshot', 'issueId']);
  return direct === issueId || payload === issueId || context === issueId;
}

function getRecordValue(input: unknown, path: string[]): string | null {
  let current: unknown = input;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === 'string' ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dispatchStatusKind(status: string): StatusKind {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'queued') return 'warn';
  if (status === 'dispatched') return 'info';
  return statusKind(status);
}

function agentName(agents: ExecutionAgent[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatElapsed(iso: string | null): string {
  if (!iso) return '0s';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '-';
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
