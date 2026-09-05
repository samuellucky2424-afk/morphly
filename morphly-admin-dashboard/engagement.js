/* Uses the existing authenticated admin transport; no keys enter this page. */
(() => {
  const root = document.getElementById('communicationsView');
  const el = (id) => document.getElementById(id);
  const form = el('engagementAnnouncementForm');
  let offset = 0;
  let busy = false;
  let count = 0;
  function feedback(kind, message) {
    const element = el(kind === 'error' ? 'engagementError' : 'engagementSuccess');
    element.textContent = message; element.hidden = !message;
  }
  function lock(value) {
    busy = value;
    root.querySelectorAll('button,select,input,textarea').forEach((control) => { control.disabled = value; });
    if (!value) { el('engagementPrevious').disabled = offset === 0; el('engagementNext').disabled = offset + 50 >= count; }
  }
  async function reload() {
    const data = await AdminAPI.request(`/api/admin-engagement?offset=${offset}`);
    count = data.reviewCount;
    el('engagementEmailStatus').textContent = `Resend: ${data.email.configured ? 'Configured' : 'Setup required — set RESEND_API_KEY and RESEND_FROM_EMAIL on the API server'}. Reviews go to ${data.email.adminEmail}. First-purchase reminder: ${data.email.reminderDays} days.`;
    el('engagementReviews').innerHTML = data.reviews.length ? data.reviews.map((review) => `<div class="engagement-entry"><div class="engagement-heading"><div><strong>${escapeHtml(review.email)}</strong><span class="engagement-meta">${escapeHtml(review.category)} · ${review.rating ? `${review.rating}/5` : 'Not rated'} · ${escapeHtml(new Date(review.created_at).toLocaleString())}</span></div><select data-review="${escapeHtml(review.id)}" aria-label="Review status for ${escapeHtml(review.email)}">${['new','reviewed','resolved'].map((status) => `<option value="${status}" ${review.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></div><p class="engagement-review-text">${escapeHtml(review.message)}</p></div>`).join('') : '<p>No reviews yet.</p>';
    el('engagementAnnouncements').innerHTML = data.announcements.length ? data.announcements.map((notice) => {
      const active = notice.active && (!notice.ends_at || Date.parse(notice.ends_at) > Date.now());
      return `<div class="engagement-entry"><strong>${escapeHtml(notice.title)}</strong><span class="engagement-meta">${escapeHtml(notice.kind)} · ${active ? Date.parse(notice.starts_at) > Date.now() ? 'Scheduled' : 'Active' : 'Ended'}</span><p>${escapeHtml(notice.message)}</p>${notice.ends_at ? `<small>Ends ${escapeHtml(new Date(notice.ends_at).toLocaleString())}</small>` : ''}${active ? `<button type="button" data-end-notice="${escapeHtml(notice.id)}">End announcement</button>` : ''}</div>`;
    }).join('') : '<p>No announcements published yet.</p>';
    el('engagementEmailJobs').innerHTML = data.jobs.length ? data.jobs.map((job) => `<div class="engagement-entry"><strong>${escapeHtml(job.kind.replaceAll('_',' '))}</strong> · ${escapeHtml(job.status)}${job.last_error ? `<p>${escapeHtml(job.last_error)}</p>` : ''}</div>`).join('') : '<p>No email activity yet.</p>';
    el('engagementPage').textContent = `${offset + (data.reviews.length ? 1 : 0)}–${offset + data.reviews.length} of ${count}`;
  }
  async function refresh() {
    if (busy) return;
    lock(true); feedback('error', '');
    try { await reload(); } catch (error) { feedback('error', error.message); } finally { lock(false); }
  }
  async function mutate(body, message) {
    if (busy) return false;
    lock(true); feedback('error', ''); feedback('success', '');
    try { await AdminAPI.request('/api/admin-engagement', { method: 'POST', body: JSON.stringify(body) }); feedback('success', message); await reload(); return true; }
    catch (error) { feedback('error', error.message); return false; }
    finally { lock(false); }
  }
  document.querySelector('[data-view="communications"]').addEventListener('click', refresh);
  el('engagementRefresh').addEventListener('click', refresh);
  form.addEventListener('input', () => {
    el('engagementPreviewTitle').textContent = form.elements.title.value || 'Announcement preview';
    el('engagementPreviewMessage').textContent = form.elements.message.value || 'Your message will appear here.';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const startsAt = fields.get('startsAt'); const endsAt = fields.get('endsAt');
    const saved = await mutate({ action: 'publish', title: fields.get('title'), message: fields.get('message'), kind: fields.get('kind'), startsAt: startsAt ? new Date(startsAt).toISOString() : null, endsAt: endsAt ? new Date(endsAt).toISOString() : null }, 'Announcement published. Open dashboards receive it within 30 seconds.');
    if (saved) { form.reset(); form.dispatchEvent(new Event('input')); }
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-end-notice]');
    if (button) void mutate({ action: 'end-announcement', id: button.dataset.endNotice }, 'Announcement ended.');
  });
  root.addEventListener('change', (event) => {
    const control = event.target.closest('[data-review]');
    if (control) void mutate({ action: 'review-status', id: control.dataset.review, status: control.value }, 'Review status updated.');
  });
  el('engagementPrevious').addEventListener('click', () => { offset = Math.max(0, offset - 50); void refresh(); });
  el('engagementNext').addEventListener('click', () => { if (offset + 50 < count) { offset += 50; void refresh(); } });
})();
