// pages/approval-queue.tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

// Simple API helpers (duplicate minimal needed functions)
async function fetchJson(url: string) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function reviewDecision(id: string, decision: 'approve' | 'reject' | 'return_to_author', note?: string) {
  return fetchJson(`/api/policy/decisions/${id}/review`);
}

interface Decision {
  id: string;
  actorLabel: string;
  actorType: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decisionReason?: string;
  proposedAt: string;
  review?: { reviewNote?: string };
}

export default function ApprovalQueuePage() {
  const [approvals, setApprovals] = useState<Decision[]>([]);
  const [selected, setSelected] = useState<Decision | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const router = useRouter();

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const data = await fetchJson('/api/policy/decisions?decision=route_to_review&reviewed=false');
        setApprovals(data);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleReview(decision: 'approve' | 'reject' | 'return_to_author') {
    if (!selected) return;
    try {
      await fetch('/api/policy/decisions/' + selected.id + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || undefined })
      });
      // refresh list
      const refreshed = await fetchJson('/api/policy/decisions?decision=route_to_review&reviewed=false');
      setApprovals(refreshed);
      setSelected(null);
      setNote('');
    } catch (e: any) {
      alert('Review failed: ' + e.message);
    }
  }

  if (loading) return <div>Loading approvals…</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div style={{ padding: '1rem', fontFamily: 'sans-serif' }}>
      <h1>Approval Queue</h1>
      <div style={{ display: 'flex', gap: '2rem' }}>
        <div style={{ flex: 1, maxHeight: '70vh', overflowY: 'auto', border: '1px solid #ddd' }}>
          {approvals.length === 0 && <p>No pending approvals</p>}
          {approvals.map(a => (
            <button
              key={a.id}
              onClick={() => setSelected(a)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem',
                background: selected?.id === a.id ? '#eef' : 'transparent',
                borderBottom: '1px solid #ccc'
              }}
            >
              <strong>{a.actorLabel}</strong> – {a.proposedActionSummary}
            </button>
          ))}
        </div>
        {selected && (
          <div style={{ flex: 1, border: '1px solid #ddd', padding: '1rem' }}>
            <h2>Review Action</h2>
            <p><strong>Actor:</strong> {selected.actorLabel} ({selected.actorType})</p>
            <p><strong>Action:</strong> {selected.proposedActionSummary}</p>
            <p><strong>Kind:</strong> {selected.proposedActionKind}</p>
            <p><strong>Submitted:</strong> {selected.proposedAt}</p>
            {selected.review?.reviewNote && <p><strong>Previous note:</strong> {selected.review.reviewNote}</p>}
            <textarea
              placeholder="Reviewer note (optional)"
              rows={4}
              value={note}
              onChange={e => setNote(e.target.value)}
              style={{ width: '100%', marginTop: '0.5rem' }}
            />
            <div style={{ marginTop: '0.5rem' }}>
              <button onClick={() => handleReview('approve')} style={{ marginRight: '0.5rem' }}>Approve</button>
              <button onClick={() => handleReview('reject')} style={{ marginRight: '0.5rem' }}>Reject</button>
              <button onClick={() => handleReview('return_to_author')}>Return to author</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
