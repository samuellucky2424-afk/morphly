import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Megaphone, Wrench, X, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { apiFetchWithAuth } from '@/lib/api-client';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import './customer-engagement.css';

type Announcement = { id: string; title: string; message: string; kind: 'update' | 'maintenance'; ends_at: string | null; revision: number };
// Reset by a new renderer/app launch, but not by visiting Wallet and returning.
const promptedUsers = new Set<string>();

export function CustomerEngagement({ paused = false }: { paused?: boolean }) {
  const { user } = useAuth();
  const [notices, setNotices] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState('experience');
  const [rating, setRating] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0);
  const requestId = useRef(crypto.randomUUID());
  const formRef = useRef<HTMLTextAreaElement>(null);
  const manualRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!user) return;
    try { setDismissed(new Set(JSON.parse(sessionStorage.getItem(`morphly-notices:${user.id}`) || '[]'))); }
    catch { setDismissed(new Set()); }
    setOpen(false); setSaved(false); setMessage(''); setError(''); setRating(''); setCategory('experience'); setNotices([]);
    requestId.current = crypto.randomUUID();
  }, [user?.id]);

  useEffect(() => {
    if (!user || paused || promptedUsers.has(user.id)) return;
    const timer = setTimeout(() => { promptedUsers.add(user.id); setOpen(true); }, 1000);
    return () => clearTimeout(timer);
  }, [user?.id, paused]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const response = await apiFetchWithAuth('/announcements', { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (controller.signal.aborted) return;
        offset.current = Date.parse(data.serverTime) - Date.now();
        setNow(Date.now() + offset.current);
        setNotices(data.announcements || []);
      } catch { /* Announcements must not prevent offline startup. */ }
      finally { loading = false; }
    }
    void refresh();
    const refreshTimer = setInterval(refresh, 30000);
    const clock = setInterval(() => setNow(Date.now() + offset.current), 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); clearInterval(refreshTimer); clearInterval(clock); document.removeEventListener('visibilitychange', refresh); };
  }, [user?.id]);

  const keyOf = (notice: Announcement) => `${notice.id}:${notice.revision}`;
  const active = notices.filter((notice) => (!notice.ends_at || Date.parse(notice.ends_at) > now) && !dismissed.has(keyOf(notice)));
  function dismiss(notice: Announcement) {
    const next = new Set(dismissed).add(keyOf(notice)); setDismissed(next);
    try { sessionStorage.setItem(`morphly-notices:${user?.id}`, JSON.stringify([...next].slice(-100))); } catch { /* memory fallback */ }
  }
  function openReview() { if (user) promptedUsers.add(user.id); setOpen(true); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setError('');
    if (message.trim().length < 10) { setError('Please write at least 10 characters so we can understand your feedback.'); formRef.current?.focus(); return; }
    setBusy(true);
    try {
      const response = await apiFetchWithAuth('/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: requestId.current, category, rating: rating ? Number(rating) : null, message }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Your review could not be saved. Please try again.');
      setSaved(true); setMessage(''); requestId.current = crypto.randomUUID();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to send feedback.'); }
    finally { setBusy(false); }
  }
  if (!user) return null;
  return <>
    <div className="morphly-community-bar">
      <div className="morphly-notices" aria-label="Morphly service announcements">
        {active.length ? active.map((notice) => <div key={keyOf(notice)} className={`morphly-notice ${notice.kind}`} role="status">
          {notice.kind === 'maintenance' ? <Wrench size={15} aria-hidden="true" /> : <Megaphone size={15} aria-hidden="true" />}
          <p><strong>{notice.title}</strong><span>{notice.message}</span></p>
          {notice.ends_at && <time className="morphly-notice-countdown" dateTime={notice.ends_at} aria-live="off" title={`Scheduled end: ${new Date(notice.ends_at).toLocaleString()}`}>
            {notice.kind === 'maintenance' ? 'Expected in ' : 'Ends in '}{formatCountdown(Date.parse(notice.ends_at) - now)}
          </time>}
          <button type="button" aria-label={`Dismiss ${notice.title}`} onClick={() => dismiss(notice)}><X size={16} /></button>
        </div>) : <span className="morphly-community-label">Morphly workspace</span>}
      </div>
      <button type="button" ref={manualRef} className="morphly-feedback-link" onClick={openReview}><MessageSquare size={14} aria-hidden="true" /> Feedback</button>
    </div>
    <Dialog open={open && !paused} onOpenChange={setOpen}>
      <DialogContent className="morphly-feedback-dialog" showCloseButton={false} onCloseAutoFocus={(event) => { event.preventDefault(); manualRef.current?.focus(); }}>
        <DialogClose className="morphly-dialog-close" aria-label="Close review form"><X size={18} /></DialogClose>
        <DialogHeader>
          <span className="morphly-feedback-eyebrow">Help shape Morphly</span>
          <DialogTitle>{saved ? 'Thank you for your feedback' : 'How is Morphly working for you?'}</DialogTitle>
          <DialogDescription>{saved ? 'Your review has been saved for our team to read.' : 'Tell us what you enjoy, what is getting in the way, or what you would like us to add.'}</DialogDescription>
        </DialogHeader>
        {saved ? <div className="morphly-feedback-success"><CheckCircle2 aria-hidden="true" /><p>Every experience helps us decide what to improve next.</p><button type="button" className="community-primary" onClick={() => setOpen(false)}>Back to Morphly</button><button type="button" onClick={() => { setSaved(false); setRating(''); }}>Write another review</button></div> :
          <form onSubmit={submit} className="morphly-feedback-form">
            <div className="morphly-feedback-fields">
              <label>Feedback type<select value={category} disabled={busy} onChange={(event) => { setCategory(event.target.value); requestId.current = crypto.randomUUID(); }}><option value="experience">My experience</option><option value="issue">Something is not working</option><option value="idea">An idea or feature request</option></select></label>
              <label>Experience rating <span>(optional)</span><select value={rating} disabled={busy} onChange={(event) => { setRating(event.target.value); requestId.current = crypto.randomUUID(); }}><option value="">Choose a rating</option>{[1,2,3,4,5].map((value) => <option key={value} value={value}>{value} / 5{value === 1 ? ' — Poor' : value === 5 ? ' — Excellent' : ''}</option>)}</select></label>
            </div>
            <label htmlFor="morphly-review-message">Your feedback</label>
            <textarea id="morphly-review-message" ref={formRef} value={message} disabled={busy} onChange={(event) => { setMessage(event.target.value); requestId.current = crypto.randomUUID(); }} maxLength={4000} rows={5} aria-invalid={Boolean(error)} aria-describedby="morphly-review-help morphly-review-error" placeholder="What happened? What could work better for you?" />
            <p id="morphly-review-help" className="community-helper">Sent privately to the Morphly team with your account email. {message.length.toLocaleString()}/4,000</p>
            {error && <p id="morphly-review-error" className="community-error" role="alert">{error}</p>}
            <div className="morphly-feedback-actions"><button type="button" onClick={() => setOpen(false)}>Maybe later</button><button type="submit" className="community-primary" disabled={busy}>{busy ? 'Sending feedback…' : 'Send feedback'}</button></div>
          </form>}
      </DialogContent>
    </Dialog>
  </>;
}

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}h ` : ''}${minutes}m ${seconds % 60}s`;
}
