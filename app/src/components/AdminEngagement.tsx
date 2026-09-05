import { useCallback, useEffect, useState } from 'react';
import { apiFetchWithAuth } from '@/lib/api-client';
import './admin-engagement.css';

interface Review { id: string; email: string; category: string; rating: number | null; message: string; status: string; created_at: string }
interface Notice { id: string; title: string; message: string; kind: string; active: boolean; starts_at: string; ends_at: string | null }
interface EngagementData {
  reviews: Review[]; reviewCount: number; announcements: Notice[];
  jobs: { id: string; kind: string; status: string; last_error: string | null }[];
  email: { configured: boolean; adminEmail: string; reminderDays: number };
}
async function request(path = '', body?: object) {
  const response = await apiFetchWithAuth(`/admin-engagement${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to update communications.');
  return data;
}
export function AdminEngagement() {
  const [data, setData] = useState<EngagementData | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState('maintenance');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const reload = useCallback(async () => { setData(await request(`?offset=${offset}`)); }, [offset]);
  useEffect(() => { let cancelled = false; setError(''); request(`?offset=${offset}`).then((result) => { if (!cancelled) setData(result); }).catch((failure) => { if (!cancelled) setError(failure.message); }); return () => { cancelled = true; }; }, [offset]);
  async function mutate(body: object, notice: string) {
    setBusy(true); setError(''); setSuccess('');
    try { await request('', body); setSuccess(notice); await reload(); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save changes.'); return false; }
    finally { setBusy(false); }
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (await mutate({ action: 'publish', title, message, kind, startsAt: start ? new Date(start).toISOString() : null, endsAt: end ? new Date(end).toISOString() : null }, 'Announcement published. Open dashboards receive it within 30 seconds.')) { setTitle(''); setMessage(''); setStart(''); setEnd(''); }
  }
  return <section className="admin-engagement" aria-label="Customer communications">
    <div className="engagement-heading"><div><h3>Customer communications</h3><p>Read feedback and keep users informed.</p></div><button disabled={busy} onClick={() => { setError(''); void reload().catch((failure) => setError(failure.message)); }}>Refresh</button></div>
    {error && <p className="engagement-error" role="alert">{error}</p>}
    {success && <p className="engagement-success" role="status">{success}</p>}
    {data && <p className="engagement-email-status">Resend: <strong>{data.email.configured ? 'Configured' : 'Setup required'}</strong> · Reviews go to {data.email.adminEmail}. First-purchase reminders: {data.email.reminderDays} days. {!data.email.configured && 'Set RESEND_API_KEY and RESEND_FROM_EMAIL on the API server.'}</p>}
    <div className="engagement-grid">
      <article className="engagement-panel"><h4>Publish an announcement</h4><p>A small, dismissible notice at the top of every user dashboard.</p>
        <form onSubmit={publish}>
          <label>Type<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="maintenance">Maintenance</option><option value="update">Product update</option></select></label>
          <label>Title<input required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Scheduled maintenance" /></label>
          <label>Message<textarea required maxLength={500} rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What is affected, and when should users return?" /></label>
          <label>Starts at <small>(optional; local time)</small><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label>
          <label>Expected end <small>(optional; local time)</small><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
          <p className="engagement-help">Set an end time to show a countdown. The notice expires automatically; it does not switch engines on or off.</p>
          <div className="engagement-preview"><strong>{title || 'Announcement preview'}</strong><span>{message || 'Your message will appear here.'}</span></div>
          <button className="engagement-primary" disabled={busy || !data}>{busy ? 'Saving…' : 'Publish to all users'}</button>
        </form>
      </article>
      <article className="engagement-panel"><h4>Recent announcements</h4>{!data ? <p>Loading announcements…</p> : !data.announcements.length ? <p>No announcements published yet.</p> : data.announcements.map((item) => {
        const live = item.active && (!item.ends_at || Date.parse(item.ends_at) > Date.now());
        return <div className="engagement-entry" key={item.id}><strong>{item.title}</strong><span className="engagement-meta">{item.kind} · {live ? Date.parse(item.starts_at) > Date.now() ? 'Scheduled' : 'Active' : 'Ended'}</span><p>{item.message}</p>{item.ends_at && <small>Ends {new Date(item.ends_at).toLocaleString()}</small>}{live && <button disabled={busy} onClick={() => void mutate({ action: 'end-announcement', id: item.id }, 'Announcement ended.')}>End announcement</button>}</div>;
      })}</article>
    </div>
    <article className="engagement-panel"><h4>Customer reviews {data ? `(${data.reviewCount})` : ''}</h4><p>Experience reports, problems and feature requests from signed-in users.</p>
      {!data ? <p>Loading reviews…</p> : !data.reviews.length ? <p>No reviews yet.</p> : data.reviews.map((review) => <div className="engagement-entry" key={review.id}>
        <div className="engagement-heading"><div><strong>{review.email}</strong><span className="engagement-meta">{review.category} · {review.rating ? `${review.rating}/5` : 'Not rated'} · {new Date(review.created_at).toLocaleString()}</span></div>
          <select aria-label={`Review status for ${review.email}`} value={review.status} disabled={busy} onChange={(event) => void mutate({ action: 'review-status', id: review.id, status: event.target.value }, 'Review status updated.')}><option value="new">New</option><option value="reviewed">Reviewed</option><option value="resolved">Resolved</option></select></div><p className="engagement-review-text">{review.message}</p></div>)}
      <div className="engagement-pagination"><button disabled={busy || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Previous</button><span>{offset + (data?.reviews.length ? 1 : 0)}–{offset + (data?.reviews.length || 0)} of {data?.reviewCount || 0}</span><button disabled={busy || !data || offset + 50 >= data.reviewCount} onClick={() => setOffset((value) => value + 50)}>Next</button></div>
    </article>
    <article className="engagement-panel"><h4>Recent email activity</h4><p>“Sent” means accepted by Resend. Failed messages remain visible for investigation.</p>{data?.jobs.length ? data.jobs.map((job) => <div className="engagement-entry" key={job.id}><strong>{job.kind.replaceAll('_', ' ')}</strong><span> · {job.status}</span>{job.last_error && <p>{job.last_error}</p>}</div>) : <p>No email activity yet.</p>}</article>
  </section>;
}
