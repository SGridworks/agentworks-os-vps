'use client';

import { useState } from 'react';
import { Eye, EyeOff, AlertTriangle, RefreshCw, Clock } from 'lucide-react';
import type { PackMode } from '@/lib/api';

interface PackModeCardProps {
  packId: string;
  currentMode: 'shadow' | 'enforce';
  modeInfo?: PackMode | null;
  onFlipComplete: (newMode: PackMode) => void;
  onError: (msg: string) => void;
  reviewerId: string;
}

export function PackModeCard({
  packId,
  currentMode,
  modeInfo,
  onFlipComplete,
  onError,
  reviewerId,
}: PackModeCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<'shadow' | 'enforce' | null>(null);
  const [reason, setReason] = useState('');
  const [flipping, setFlipping] = useState(false);

  function openFlip(target: 'shadow' | 'enforce') {
    setPendingMode(target);
    setReason('');
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    if (!pendingMode) return;
    setFlipping(true);
    try {
      const { flipPackMode } = await import('@/lib/api');
      const result = await flipPackMode(packId, pendingMode, reviewerId, reason || undefined);
      onFlipComplete(result);
      setConfirmOpen(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Flip failed');
    } finally {
      setFlipping(false);
    }
  }

  const isShadow = currentMode === 'shadow';

  return (
    <>
      <div className="rounded-lg border border-border bg-card">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded flex items-center justify-center shrink-0 ${
              isShadow ? 'bg-warning/10' : 'bg-success/10'
            }`}>
              {isShadow
                ? <Eye className="w-4 h-4 text-warning" />
                : <EyeOff className="w-4 h-4 text-success" />
              }
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Enforcement Mode</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ${
                  isShadow
                    ? 'bg-warning/10 text-warning'
                    : 'bg-success/10 text-success'
                }`}>
                  {isShadow ? (
                    <><Eye className="w-3 h-3" /> Shadow (log only)</>
                  ) : (
                    <><EyeOff className="w-3 h-3" /> Enforcing</>
                  )}
                </span>
              </div>
            </div>
          </div>

          <button
            className={`btn btn-sm ${isShadow ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => openFlip(isShadow ? 'enforce' : 'shadow')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {isShadow ? 'Enable enforcement' : 'Switch to shadow'}
          </button>
        </div>

        {/* Audit trail */}
        {modeInfo?.flippedAt && (
          <div className="px-5 pb-4 border-t border-border pt-3">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Last flipped {new Date(modeInfo.flippedAt).toLocaleDateString()}
              </span>
              {modeInfo.flippedBy && (
                <span>by {modeInfo.flippedBy}</span>
              )}
              {modeInfo.reason && (
                <span className="italic">&ldquo;{modeInfo.reason}&rdquo;</span>
              )}
            </div>
          </div>
        )}

        {/* What this means */}
        <div className="px-5 pb-4">
          <div className={`rounded p-3 text-xs leading-relaxed ${
            isShadow
              ? 'bg-muted/40 text-muted-foreground'
              : 'bg-success/5 text-foreground border border-success/20'
          }`}>
            {isShadow ? (
              <><AlertTriangle className="w-3 h-3 inline-block mr-1 text-warning" />
              Shadow mode: decisions are <strong>logged but not enforced</strong>.
              Matching actions are allowed through and flagged for review.</>
            ) : (
              <><strong>Enforcing:</strong> matching actions will be
              <strong> blocked</strong> or <strong>routed to review</strong>
              based on rule pack configuration.</>
            )}
          </div>
        </div>
      </div>

      {/* Confirm modal */}
      {confirmOpen && pendingMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl border border-border shadow-xl w-full max-w-md mx-4">
            <div className="flex items-start gap-4 p-6">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                pendingMode === 'enforce'
                  ? 'bg-success/10'
                  : 'bg-warning/10'
              }`}>
                {pendingMode === 'enforce'
                  ? <EyeOff className="w-5 h-5 text-success" />
                  : <Eye className="w-5 h-5 text-warning" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-foreground">
                  {pendingMode === 'enforce'
                    ? 'Enable enforcement?'
                    : 'Switch to shadow mode?'
                  }
                </h2>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {pendingMode === 'enforce' ? (
                    <>Once enforced, actions matching this rule pack will be{' '}
                      <strong>blocked or routed to review</strong> — they will not complete.
                      This takes effect immediately on the daemon.</>
                  ) : (
                    <>In shadow mode, all matching actions are{' '}
                      <strong>logged but allowed through</strong>.
                      No actions will be blocked. Shadow logs remain queryable.</>
                  )}
                </p>
              </div>
            </div>

            <div className="px-6 pb-2">
              <label className="block text-xs text-muted-foreground mb-1.5">
                Reason <span className="text-muted-foreground/50">(optional)</span>
              </label>
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-2 focus:ring-accent"
                rows={2}
                placeholder="Why are you changing the mode?"
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmOpen(false)}
                disabled={flipping}
              >
                Cancel
              </button>
              <button
                className={`btn btn-sm ${pendingMode === 'enforce' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={handleConfirm}
                disabled={flipping}
              >
                {flipping
                  ? 'Applying...'
                  : pendingMode === 'enforce'
                    ? 'Yes, enable enforcement'
                    : 'Yes, switch to shadow'
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
