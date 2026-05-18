"use client";

import { useEffect, useState } from "react";
import { Circle } from 'lucide-react';
import Link from "next/link";
import { getIssue, getAgent, listDispatchQueue, listTenants, type DispatchQueueRow, type ExecutionIssue, type ExecutionAgent } from "@/lib/api";
import { V2Shell } from "@/components/v2/shell";
import { useV2Nav } from '@/components/v2/nav';

type StatusPillKind = 'info' | 'warn' | 'error' | 'success' | 'muted';

function StatusPill({ kind, children }: { kind: StatusPillKind; children: React.ReactNode }) {
  const colors: Record<StatusPillKind, string> = {
    info: 'var(--accent)',
    warn: 'var(--warn)',
    error: 'var(--err)',
    success: 'var(--ok)',
    muted: 'var(--ink-3)',
  };
  return (
    <span style={{ fontSize: 11, color: colors[kind], fontFamily: "'JetBrains Mono', monospace" }}>
      {children}
    </span>
  );
}

function StatusDot({ kind, pulse, size }: { kind: StatusPillKind; pulse?: boolean; size?: number }) {
  const colors: Record<StatusPillKind, string> = {
    info: 'var(--accent)',
    warn: 'var(--warn)',
    error: 'var(--err)',
    success: 'var(--ok)',
    muted: 'var(--ink-3)',
  };
  return (
    <Circle
      size={size ?? 8}
      fill={colors[kind]}
      color={colors[kind]}
      style={pulse ? { animation: 'pulse 2s infinite' } : undefined}
    />
  );
}

function relTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function useTranslation() {
  return { t: (key: string, _opts?: unknown) => null as string | null };
}

const POLL_MS = 3000;

interface ActiveWorkRow {
  dispatch: DispatchQueueRow;
  issue: ExecutionIssue | null;
  agent: ExecutionAgent | null;
}

export default function ActiveWorkPage() {
  const navigate = useV2Nav();
  const [rows, setRows] = useState<ActiveWorkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchAndCategorize() {
      try {
        const tenants = await listTenants();
        const tenant = tenants[0];
        // Get all dispatch queue items (remove status filter)
        const page = await listDispatchQueue({ tenantId: tenant?.id, limit: 200 });
        const allRows = page.items;

        // Categorize rows
        const activeDispatches = allRows.filter(r => r.status === "dispatched");
        const queuedBackpressure = allRows.filter(r => r.status === "queued");
        const completedRecent = allRows.filter(
          r => r.status === "completed" && (Date.now() - new Date(r.createdAt).getTime()) / 1000 < 86400
        );
        const failedRecent = allRows.filter(
          r => r.status === "failed" && (Date.now() - new Date(r.createdAt).getTime()) / 1000 < 86400
        );
        const staleDrift = allRows.filter(
          r => r.status === "in_progress" && !(r.input && typeof r.input === 'object' && 'reason' in r.input && (r.input as Record<string, unknown>)['reason'])
        );

        const enriched = await Promise.all(
          [...activeDispatches, ...queuedBackpressure, ...completedRecent, ...failedRecent, ...staleDrift].map(
            enrichDispatchRow
          )
        );
        if (!cancelled) {
          setRows(enriched);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(fetchAndCategorize, POLL_MS);
        }
      }
    }

    fetchAndCategorize();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <V2Shell
      active="active-work"
      onNav={navigate}
      tenant={{ mark: "AW", name: t("active_work.title") ?? "Active Work" }}
      triageCount={0}
    >
      <div className="poll-bar" />
      <div className="pageheader" style={{ paddingBottom: 14, borderBottom: "1px solid var(--rule)" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            {t("active_work.subheader") ?? "OPERATE - ACTIVE WORK"}
          </div>
          <h1 className="pageheader-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <StatusDot
              kind={rows.length ? "info" : "muted"}
              pulse={rows.length > 0}
              size={8}
            />
            {t("active_work.heading") ?? "Active Work"}
          </h1>
        </div>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: ".06em" }}>
          POLLING - 3s
        </span>
      </div>

      <div style={{ padding: 24, overflowY: "auto" }}>
        {error && <StatusPill kind="error">{error}</StatusPill>}
        <div className="card" style={{ padding: 0, marginTop: error ? 14 : 0 }}>
          <div
            className="eyebrow"
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--rule)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Circle size={14} color="var(--ink-3)" />
            {t("active_work.stats", { count: rows.length }) ?? "Active Work Dispatches"}
          </div>
          {loading ? (
            <div className="mono" style={{ padding: 18, fontSize: 12, color: "var(--ink-4)" }}>
              {t("active_work.loading") ?? "Loading active work..."}
            </div>
          ) : rows.length === 0 ? (
            <div className="mono" style={{ padding: 18, fontSize: 12, color: "var(--ink-4)" }}>
              {t("active_work.empty") ?? "No active work."}
            </div>
          ) : (
            <div>
              {[
                { label: t("active_work.active"), rows: rows.filter(r => r.dispatch.status === "dispatched") },
                {
                  label: t("active_work.queuedBackpressure"),
                  rows: rows.filter(r => r.dispatch.status === "queued"),
                },
                {
                  label: t("active_work.completedRecent"),
                  rows: rows.filter(
                    r => r.dispatch.status === "completed" && (Date.now() - new Date(r.dispatch.createdAt).getTime()) / 1000 < 86400
                  ),
                },
                {
                  label: t("active_work.failedRecent"),
                  rows: rows.filter(
                    r => r.dispatch.status === "failed" && (Date.now() - new Date(r.dispatch.createdAt).getTime()) / 1000 < 86400
                  ),
                },
                {
                  label: t("active_work.staleDrift"),
                  rows: rows.filter(r => r.dispatch.status === "in_progress" && !(r.dispatch.input && typeof r.dispatch.input === 'object' && 'reason' in r.dispatch.input && (r.dispatch.input as Record<string, unknown>)['reason'])),
                },
              ].map(({ label, rows: sectionRows }) => {
                if (sectionRows.length === 0) return null;
                return (
                  <div key={label} style={{ marginBottom: 24 }}>
                    <div className="font-medium mb-2">{label}</div>
                    {sectionRows.map(row => (
                      <div
                        key={row.dispatch.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "110px 106px 88px minmax(0, 1.4fr) minmax(0, 1fr) 96px",
                          gap: 14,
                          alignItems: "center",
                          padding: "10px 14px",
                          borderTop: "1px solid var(--rule)",
                        }}
                      >
                        <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>
                          {relTime(row.dispatch.createdAt)}
                        </span>
                        <StatusPill
                          kind={dispatchStatusKind(row.dispatch.status)}
                        >{row.dispatch.status}</StatusPill>
                        {row.issue ? (
                          <Link
                            href={`/mission-control/${row.issue.companyId}/issues/${row.issue.id}/activity`}
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: "var(--accent)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              display: "block",
                            }}
                          >
                            {row.dispatch.id.slice(0, 8)}
                          </Link>
                        ) : (
                          <span
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: "var(--ink-3)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              display: "block",
                            }}
                            title="No issue link found on this dispatch row"
                          >
                            {row.dispatch.id.slice(0, 8)}
                          </span>
                        )}
                        <div style={{ minWidth: 0 }}>
                          {row.issue ? (
                            <>
                              <Link
                                href={`/mission-control/${row.issue.companyId}/issues/${row.issue.id}/activity`}
                                className="mono"
                                style={{
                                  fontSize: 12,
                                  color: "var(--accent)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  display: "block",
                                }}
                              >
                                {row.issue.identifier} - {row.issue.title}
                              </Link>
                              <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>
                                {row.dispatch.taskKind}
                              </div>
                              <div className="mono" style={{ fontSize: 11, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {row.agent?.name ?? row.dispatch.targetAgentId}
                              </div>
                              <div className="mono tabular" style={{ textAlign: "right", fontSize: 12, color: "var(--ink-2)" }}>
                                {formatElapsed(row.dispatch.dispatchedAt ?? row.dispatch.createdAt)}
                              </div>
                              {/* Show error or latest comment if available */}
                              {row.dispatch.error && (
                                <div className="mono" style={{ fontSize: 10, color: "var(--error)", marginTop: 2 }} title={row.dispatch.error}>
                                  ⚠️ {row.dispatch.error}
                                </div>
                              )}
                              {row.issue?.latestCommentAt && (
                                <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>
                                  Comment: {row.issue.latestCommentAt}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="mono" style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {dispatchReason(row.dispatch)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 16, marginTop: 14, display: "flex", gap: 10, color: "var(--ink-3)", fontSize: 12 }}>
          <Circle size={16} color="var(--ink-3)" aria-hidden="true" />
          <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            {t("active_work.caption") ?? "This page shows categorized runtime state from the dispatch queue."}
          </div>
        </div>
      </div>
    </V2Shell>
  );
}

// ---------------------------------------------------------------------------
// Helper functions – unchanged from previous implementation
// ---------------------------------------------------------------------------

async function enrichDispatchRow(dispatch: DispatchQueueRow): Promise<ActiveWorkRow> {
  const issueId = dispatchIssueId(dispatch);
  const [issue, agent] = await Promise.all([
    issueId ? getIssue(issueId).catch(() => null) : Promise.resolve(null),
    getAgent(dispatch.targetAgentId).catch(() => null),
  ]);
  return { dispatch, issue, agent };
}

function dispatchIssueId(row: DispatchQueueRow): string | null {
  const input = row.input;
  if (!input || typeof input !== "object") return null;
  const direct = (input as { issueId?: unknown }).issueId;
  if (typeof direct === "string") return direct;
  const payload = (input as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;
  const nested = (payload as { issueId?: unknown }).issueId;
  return typeof nested === "string" ? nested : null;
}

function dispatchReason(row: DispatchQueueRow): string {
  const input = row.input;
  if (!input || typeof input !== "object") return row.taskKind;
  const reason = (input as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : row.taskKind;
}

function dispatchStatusKind(status: string): StatusPillKind {
  if (status === "dispatched") return "info";
  if (status === "queued") return "warn";
  if (status === "failed") return "error";
  if (status === "completed") return "success";
  return "muted";
}

function formatElapsed(iso: string | null): string {
  if (!iso) return "0s";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
