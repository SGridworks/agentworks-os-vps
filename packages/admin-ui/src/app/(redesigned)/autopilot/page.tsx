'use client';

import { useEffect, useState } from 'react';
import { useV2Nav } from '@/components/v2/nav';
import { V2Shell, Breadcrumb, EmptyState, FilterBar } from '@/components/v2/shell';
import { listAutopilotActions, dispatchAutopilotActions, type AutopilotAction } from '@/lib/api';
import { AlertTriangle, CheckCircle, Clock, Plane, RefreshCw, X, Info } from 'lucide-react';

interface BucketedActions {
  safe: AutopilotAction[];
  needsApproval: AutopilotAction[];
  risky: AutopilotAction[];
}

interface PopoverState {
  isOpen: boolean;
  action: AutopilotAction | null;
  position: { top: number; left: number };
}

export default function AutopilotPage() {
  const navigate = useV2Nav();
  const [actions, setActions] = useState<BucketedActions>({ safe: [], needsApproval: [], risky: [] });
  const [loading, setLoading] = useState(true);
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [processing, setProcessing] = useState<string | null>(null);
  const [popover, setPopover] = useState<PopoverState>({ isOpen: false, action: null, position: { top: 0, left: 0 } });

  useEffect(() => {
    loadActions();
  }, [selectedTenant]);

  async function loadActions() {
    setLoading(true);
    try {
      const allActions = await listAutopilotActions(selectedTenant || undefined);
      const bucketed: BucketedActions = {
        safe: allActions.filter(a => a.decision === 'allow'),
        needsApproval: allActions.filter(a => a.decision === 'needsApproval'),
        risky: allActions.filter(a => a.decision === 'risky'),
      };
      setActions(bucketed);
    } catch (error) {
      console.error('Failed to load autopilot actions:', error);
    } finally {
      setLoading(false);
    }
  }

  function handleActionClick(action: AutopilotAction, event: React.MouseEvent) {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setPopover({
      isOpen: true,
      action,
      position: {
        top: rect.bottom + 8,
        left: Math.min(rect.left, window.innerWidth - 400) // Prevent overflow
      }
    });
  }

  function closePopover() {
    setPopover({ isOpen: false, action: null, position: { top: 0, left: 0 } });
  }

  async function handleBulkAction(bucket: keyof BucketedActions) {
    const actionIds = actions[bucket].map(a => a.actionId);
    if (actionIds.length === 0) return;

    setProcessing(bucket);
    try {
      await dispatchAutopilotActions(actionIds, false);
      // Reload actions after dispatch
      await loadActions();
    } catch (error) {
      console.error(`Failed to dispatch ${bucket} actions:`, error);
    } finally {
      setProcessing(null);
    }
  }

  function getBucketLabel(bucket: keyof BucketedActions): string {
    switch (bucket) {
      case 'safe': return 'Safe';
      case 'needsApproval': return 'Needs Approval';
      case 'risky': return 'Risky';
    }
  }

  function getBucketIcon(bucket: keyof BucketedActions) {
    switch (bucket) {
      case 'safe': return CheckCircle;
      case 'needsApproval': return Clock;
      case 'risky': return AlertTriangle;
    }
  }

  function getBucketColor(bucket: keyof BucketedActions): string {
    switch (bucket) {
      case 'safe': return 'var(--success)';
      case 'needsApproval': return 'var(--warn)';
      case 'risky': return 'var(--error)';
    }
  }

  function getActionButtonLabel(bucket: keyof BucketedActions): string {
    switch (bucket) {
      case 'safe': return 'Dispatch All Safe';
      case 'needsApproval': return 'Approve All Needs-Approval';
      case 'risky': return 'Acknowledge All Risky';
    }
  }

  return (
    <V2Shell active="autopilot" onNav={navigate}>
      <div style={{ padding: '24px 32px' }}>
        <Breadcrumb items={['Autopilot']} />
        
        <div style={{ marginTop: 24, marginBottom: 32 }}>
          <h1 className="serif" style={{ fontSize: 28, marginBottom: 8 }}>
            Autopilot
          </h1>
          <p style={{ color: 'var(--ink-3)', fontSize: 14 }}>
            Review and manage actions automatically categorized by risk level
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginBottom: 32 }}>
          {(Object.keys(actions) as Array<keyof BucketedActions>).map(bucket => {
            const Icon = getBucketIcon(bucket);
            const color = getBucketColor(bucket);
            const bucketActions = actions[bucket];
            const label = getBucketLabel(bucket);
            const buttonLabel = getActionButtonLabel(bucket);

            return (
              <div key={bucket} style={{ 
                border: '1px solid var(--rule)', 
                borderRadius: 8, 
                padding: 20,
                background: 'var(--bg-card)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
                  <Icon size={20} strokeWidth={1.6} style={{ color, marginRight: 8 }} />
                  <h3 style={{ fontSize: 16, fontWeight: 500 }}>{label}</h3>
                  <span style={{ 
                    marginLeft: 'auto', 
                    background: color, 
                    color: 'white',
                    padding: '2px 8px', 
                    borderRadius: 12, 
                    fontSize: 12,
                    fontWeight: 500
                  }}>
                    {bucketActions.length}
                  </span>
                </div>

                <div style={{ marginBottom: 16, minHeight: 200 }}>
                  {loading ? (
                    <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
                      <RefreshCw size={16} style={{ marginBottom: 8, animation: 'spin 1s linear infinite' }} />
                      Loading...
                    </div>
                  ) : bucketActions.length === 0 ? (
                    <EmptyState
                      icon={Icon}
                      title={`No ${label.toLowerCase()} actions`}
                      body={`There are currently no actions categorized as ${label.toLowerCase()}.`}
                    />
                  ) : (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      {bucketActions.slice(0, 5).map(action => (
                        <div 
                          key={action.id} 
                          style={{ 
                            padding: '12px', 
                            border: '1px solid var(--rule-2)', 
                            borderRadius: 4, 
                            marginBottom: 8,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            position: 'relative'
                          }}
                          onClick={(e) => handleActionClick(action, e)}
                          className="action-item"
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                            e.currentTarget.style.borderColor = 'var(--rule)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = '';
                            e.currentTarget.style.borderColor = 'var(--rule-2)';
                          }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                            {action.proposedActionSummary}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
                            {action.actorLabel} • {new Date(action.proposedAt).toLocaleString()}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                            Risk Score: {action.riskScore.toFixed(2)}
                            {action.reasons.length > 0 && (
                              <span style={{ marginLeft: 8 }}>
                                Reasons: {action.reasons.slice(0, 2).join(', ')}
                                {action.reasons.length > 2 && ` +${action.reasons.length - 2} more`}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {bucketActions.length > 5 && (
                        <div style={{ 
                          textAlign: 'center', 
                          padding: '8px', 
                          color: 'var(--ink-3)', 
                          fontSize: 12 
                        }}>
                          +{bucketActions.length - 5} more actions
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <button
                  className="btn btn-primary"
                  style={{ width: '100%' }}
                  onClick={() => handleBulkAction(bucket)}
                  disabled={bucketActions.length === 0 || processing === bucket}
                >
                  {processing === bucket ? (
                    <>
                      <RefreshCw size={14} style={{ marginRight: 6, animation: 'spin 1s linear infinite' }} />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Plane size={14} style={{ marginRight: 6 }} />
                      {buttonLabel}
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ 
          background: 'var(--bg-2)', 
          border: '1px solid var(--rule)', 
          borderRadius: 8, 
          padding: 16,
          marginTop: 24
        }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <Plane size={16} style={{ marginRight: 8, color: 'var(--accent)' }} />
            <h4 style={{ fontSize: 14, fontWeight: 500 }}>Autopilot Status</h4>
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
            Autopilot automatically categorizes actions based on risk scores. 
            Safe actions (≤ 0.30) can be dispatched automatically, 
            needs-approval actions (0.30-0.70) require human review, 
            and risky actions (≥ 0.70) are blocked.
          </p>
        </div>
      </div>

      {/* Explain Popover */}
      {popover.isOpen && popover.action && (
        <>
          {/* Backdrop */}
          <div 
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              zIndex: 40
            }}
            onClick={closePopover}
          />
          
          {/* Popover */}
          <div 
            style={{
              position: 'fixed',
              top: popover.position.top,
              left: popover.position.left,
              width: '380px',
              maxHeight: '400px',
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--rule)',
              borderRadius: '8px',
              boxShadow: 'var(--shadow-2)',
              zIndex: 50,
              overflow: 'hidden'
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid var(--rule)',
              backgroundColor: 'var(--bg-2)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Info size={16} style={{ color: 'var(--accent)' }} />
                <h3 style={{ fontSize: '14px', fontWeight: 500, margin: 0 }}>
                  Action Details
                </h3>
              </div>
              <button
                onClick={closePopover}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--ink-3)',
                  padding: '4px'
                }}
                aria-label="Close popover"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div style={{ padding: '20px', maxHeight: '320px', overflowY: 'auto' }}>
              {/* Action Summary */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
                  {popover.action.proposedActionSummary}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                  {popover.action.actorLabel} • {new Date(popover.action.proposedAt).toLocaleString()}
                </div>
              </div>

              {/* Risk Assessment */}
              <div style={{ marginBottom: '16px' }}>
                <h4 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
                  Risk Assessment
                </h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Risk Score:</span>
                  <span style={{ 
                    fontSize: '13px', 
                    fontWeight: 500,
                    color: popover.action.riskScore <= 0.3 ? 'var(--ok)' : 
                           popover.action.riskScore <= 0.7 ? 'var(--warn)' : 'var(--err)'
                  }}>
                    {popover.action.riskScore.toFixed(2)}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Decision:</span>
                  <span style={{ 
                    fontSize: '12px', 
                    fontWeight: 500,
                    textTransform: 'capitalize',
                    color: popover.action.decision === 'allow' ? 'var(--ok)' :
                           popover.action.decision === 'needsApproval' ? 'var(--warn)' : 'var(--err)'
                  }}>
                    {popover.action.decision === 'allow' ? 'Safe' :
                     popover.action.decision === 'needsApproval' ? 'Needs Approval' : 'Risky'}
                  </span>
                </div>
              </div>

              {/* Bucketing Reasons */}
              {popover.action.reasons.length > 0 && (
                <div style={{ marginBottom: '16px' }}>
                  <h4 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
                    Bucketing Reasons
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: 'var(--ink-2)' }}>
                    {popover.action.reasons.map((reason, index) => (
                      <li key={index} style={{ marginBottom: '4px' }}>
                        {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Policy Decision Details */}
              <div>
                <h4 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
                  Policy Decision Details
                </h4>
                <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
                  <div style={{ marginBottom: '4px' }}>
                    <strong>Action ID:</strong> {popover.action.actionId}
                  </div>
                  <div style={{ marginBottom: '4px' }}>
                    <strong>Actor ID:</strong> {popover.action.actorId}
                  </div>
                  <div style={{ marginBottom: '4px' }}>
                    <strong>Actor Type:</strong> {popover.action.actorType}
                  </div>
                  <div style={{ marginBottom: '4px' }}>
                    <strong>Tenant ID:</strong> {popover.action.tenantId}
                  </div>
                  <div style={{ marginBottom: '4px' }}>
                    <strong>Proposed Action Kind:</strong> {popover.action.proposedActionKind}
                  </div>
                  <div>
                    <strong>Decided At:</strong> {new Date(popover.action.decidedAt).toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </V2Shell>
  );
}