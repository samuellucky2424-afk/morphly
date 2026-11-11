(function () {
  "use strict";
  const rootId = "affiliateAdminRoot";
  const state = { tab: "overview", role: "", loading: false, error: "", notice: "", payload: null, status: "pending", search: "", preset: "30d", from: "", to: "" };
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);
  const money = (kobo) => {
    const amount = Number(kobo) || 0;
    const sign = amount < 0 ? "-" : "";
    const abs = Math.abs(amount);
    return `${sign}₦${Math.floor(abs / 100).toLocaleString("en-NG")}.${String(abs % 100).padStart(2, "0")}`;
  };

  async function request(path, options = {}) {
    let accessToken = window.morphlyAccessToken;
    if (!accessToken && window.morphlySupabase) {
      const session = (await window.morphlySupabase.auth.getSession()).data.session;
      accessToken = session?.access_token || "";
      window.morphlyAccessToken = accessToken || null;
    }
    if (!accessToken) throw new Error("Your admin session has expired.");
    const base = window.MORPHLY_API_BASE || window.location.origin;
    const response = await fetch(`${base}${path}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (options.csv) {
      if (!response.ok) throw new Error("Unable to export withdrawals");
      return response.text();
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function toast(message) {
    const node = $("#affiliateNotice");
    if (!node) return;
    node.hidden = false;
    node.textContent = message;
  }

  async function copyText(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied.`);
    } catch {
      toast(`Unable to copy ${label.toLowerCase()}.`);
    }
  }

  function tabs() {
    return ["overview", "partners", "commissions", "withdrawals", "analytics", "settings", "audit"].map((id) => {
      const label = { overview: "Overview", partners: "Affiliates", commissions: "Commissions", withdrawals: "Withdrawals", analytics: "Analytics", settings: "Settings", audit: "Audit" }[id];
      return `<button type="button" class="${state.tab === id ? "primary-button" : "secondary-button"}" data-aff-tab="${id}">${label}</button>`;
    }).join(" ");
  }

  function shell(body) {
    return `<div class="toolbar" style="align-items:center">${tabs()}</div>
      <p id="affiliateNotice" class="permission-banner" ${state.notice ? "" : "hidden"}>${escapeHtml(state.notice)}</p>
      ${state.error ? `<p class="permission-banner" role="alert">${escapeHtml(state.error)}</p>` : ""}
      ${state.loading ? `<p class="empty-cell">Loading…</p>` : body}`;
  }

  function overview(data) {
    const cards = [
      ["Affiliates", data.affiliates],
      ["Pending applications", data.pendingApplications],
      ["Active", data.activeAffiliates],
      ["Attributed revenue", money(data.attributedRevenueKobo)],
      ["Commission", money(data.commissionKobo)],
      ["Payouts waiting", data.pendingPayouts],
      ["Available balances", money(data.availableKobo)],
      ["Reserved", money(data.reservedKobo)],
    ];
    return `<div class="metric-grid">${cards.map(([label, value]) => `<article class="panel"><p class="eyebrow">${escapeHtml(label)}</p><h2>${escapeHtml(value)}</h2></article>`).join("")}</div>
      <article class="panel"><p>Withdrawals are paid manually. Automatic payouts are not available.</p><label><input type="checkbox" disabled> Automatic payouts (not implemented)</label></article>`;
  }

  function partners(rows) {
    if (!rows.length) return `<p class="empty-cell">No affiliates match this search.</p>`;
    return `<div class="table-wrap"><table><thead><tr><th>Affiliate</th><th>Status</th><th>Code</th><th>Rate override</th><th>Actions</th></tr></thead><tbody>${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.name || "Affiliate")}</strong><small>${escapeHtml(row.email || "")}</small></td>
      <td><span class="status-pill ${row.status === "active" ? "success" : row.status === "pending" ? "pending" : "suspended"}">${escapeHtml(row.status)}</span>${row.flagged ? ` <span class="status-pill warning">Flagged</span>` : ""}</td>
      <td>${escapeHtml(row.code || "—")}</td>
      <td>${row.rateBpsOverride == null ? "Default" : `${row.rateBpsOverride / 100}%`}</td>
      <td class="row-actions">
        ${row.status === "pending" ? `<button class="secondary-button" type="button" data-aff-action="approve" data-id="${escapeHtml(row.id)}">Approve</button><button class="secondary-button" type="button" data-aff-action="reject" data-id="${escapeHtml(row.id)}">Reject</button>` : ""}
        ${row.status === "active" ? `<button class="secondary-button" type="button" data-aff-action="suspend" data-id="${escapeHtml(row.id)}">Suspend</button>` : ""}
        ${row.status === "suspended" ? `<button class="secondary-button" type="button" data-aff-action="activate" data-id="${escapeHtml(row.id)}">Activate</button>` : ""}
        <button class="secondary-button" type="button" data-aff-action="flag" data-id="${escapeHtml(row.id)}">Flag</button>
        <button class="secondary-button" type="button" data-aff-action="clear-flag" data-id="${escapeHtml(row.id)}">Clear flag</button>
        ${state.role === "super_admin" ? `<button class="secondary-button" type="button" data-aff-action="rate" data-id="${escapeHtml(row.id)}">Future rate</button>` : ""}
      </td></tr>`).join("")}</tbody></table></div>`;
  }

  function withdrawals(rows) {
    return `<article class="panel"><strong>Manual payouts only.</strong><p>Send the net amount to the full account number below, record the bank transfer reference, then mark Paid. Morphly does not send the money.</p><label><input type="checkbox" disabled> Automatic payouts (not implemented)</label></article>
      <div class="toolbar"><label>Status <select id="affStatus"><option value="pending">Pending</option><option value="approved">Approved</option><option value="processing">Processing</option><option value="paid">Paid</option><option value="rejected">Rejected</option><option value="failed">Failed</option><option value="all">All</option></select></label>
      <input id="affSearch" placeholder="Search affiliate" value="${escapeHtml(state.search)}">
      <button class="secondary-button" type="button" id="affExport">Export CSV</button></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Affiliate</th><th>Net to send</th><th>Bank</th><th>Account number</th><th>Account name</th><th>Status</th><th>Action</th></tr></thead><tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.affiliateName || row.affiliateId || "")}<small>${escapeHtml(row.createdAt || "")}</small></td>
        <td><strong>${money(row.netKobo)}</strong><small>${money(row.amountKobo)} requested, fee ${money(row.feeKobo)}</small></td>
        <td>${escapeHtml(row.bank?.bankName || "—")}</td>
        <td><span class="mono">${escapeHtml(row.bank?.accountNumber || "")}</span> <button class="secondary-button" type="button" data-copy="${escapeHtml(row.bank?.accountNumber || "")}" data-copy-label="Account number">Copy</button></td>
        <td>${escapeHtml(row.bank?.accountName || "")} <button class="secondary-button" type="button" data-copy="${escapeHtml(row.bank?.accountName || "")}" data-copy-label="Account name">Copy</button></td>
        <td><span class="status-pill ${row.status === "paid" ? "success" : row.status === "pending" || row.status === "processing" || row.status === "approved" ? "pending" : "suspended"}">${escapeHtml(row.status)}</span></td>
        <td>
          ${row.status === "pending" ? `<button class="primary-button" type="button" data-wd="withdrawal-approve" data-id="${escapeHtml(row.id)}">Approve</button> <button class="secondary-button" type="button" data-wd="withdrawal-reject" data-id="${escapeHtml(row.id)}">Reject</button>` : ""}
          ${row.status === "approved" || row.status === "processing" ? `<input data-ref-for="${escapeHtml(row.id)}" placeholder="Transfer reference" value="${escapeHtml(row.transferRef || "")}"> <button class="secondary-button" type="button" data-wd="withdrawal-transfer" data-id="${escapeHtml(row.id)}">Save reference</button> <button class="primary-button" type="button" data-wd="withdrawal-paid" data-id="${escapeHtml(row.id)}" ${row.transferRef ? "" : "disabled"}>Mark paid</button> <button class="secondary-button" type="button" data-wd="withdrawal-fail" data-id="${escapeHtml(row.id)}">Failed</button>` : ""}
          ${row.transferRef ? `<small>Ref ${escapeHtml(row.transferRef)}</small>` : ""}
        </td>
      </tr>`).join("")}
      </tbody></table></div>` : `<p class="empty-cell">No withdrawals in this filter.</p>`}`;
  }

  function settings(data) {
    const disabled = state.role === "super_admin" ? "" : "disabled";
    const settings = data.settings || data;
    const fields = [
      ["registrationsEnabled", "Registrations open", "checkbox"],
      ["commissionsEnabled", "Commission generation", "checkbox"],
      ["manualAffiliateApproval", "Manual affiliate approval", "checkbox"],
      ["manualWithdrawalApproval", "Manual withdrawal approval", "checkbox"],
      ["defaultRateBps", "Default rate (basis points, 600 = 6%)", "number"],
      ["durationDays", "Earning window days", "number"],
      ["maxDaysBeforeFirstPurchase", "Days to first purchase", "number"],
      ["minWithdrawalKobo", "Minimum withdrawal (kobo)", "number"],
      ["holdDays", "Holding days", "number"],
      ["estimatedTransferFeeKobo", "Estimated transfer fee (kobo)", "number"],
    ];
    return `<article class="panel"><p>Settings apply to future referrals and future commissions. Existing windows and earned commissions stay as they were. Withdrawals remain manual.</p>
      <form id="affSettings" class="form">${fields.map(([key, label, type]) => type === "checkbox"
        ? `<label><input name="${key}" type="checkbox" ${settings[key] ? "checked" : ""} ${disabled}> ${escapeHtml(label)}</label>`
        : `<label><span>${escapeHtml(label)}</span><input name="${key}" type="number" value="${escapeHtml(settings[key])}" ${disabled}></label>`).join("")}
      <label>Transfer fee payer <select name="transferFeePayer" ${disabled}><option value="affiliate" ${settings.transferFeePayer === "affiliate" ? "selected" : ""}>Affiliate pays</option><option value="platform" ${settings.transferFeePayer === "platform" ? "selected" : ""}>Morphly pays</option></select></label>
      <label><input type="checkbox" disabled> Automatic payouts (not implemented)</label>
      <button class="primary-button" type="submit" ${disabled}>Save settings</button>
      ${state.role === "super_admin" ? "" : "<p>Only a super admin can change these settings.</p>"}
      </form></article>`;
  }

  function analytics(data) {
    const max = Math.max(1, ...(data.series || []).map((row) => row.revenueKobo));
    const bars = (data.series || []).map((row) => `<div style="display:flex;align-items:flex-end;gap:4px;height:120px"><div title="${escapeHtml(row.day)}" style="width:18px;height:${Math.max(4, Math.round((row.revenueKobo / max) * 110))}px;background:#c82436;border-radius:4px 4px 0 0"></div></div>`).join("");
    return `<div class="toolbar"><button type="button" class="secondary-button" data-preset="today">Today</button><button type="button" class="secondary-button" data-preset="7d">7 days</button><button type="button" class="secondary-button" data-preset="30d">30 days</button>
      <input id="affFrom" type="date" value="${escapeHtml(state.from)}"><input id="affTo" type="date" value="${escapeHtml(state.to)}"><button class="secondary-button" type="button" id="affCustom">Custom</button></div>
      <div class="metric-grid">
        <article class="panel"><p class="eyebrow">Attributed revenue</p><h2>${money(data.attributedRevenueKobo)}</h2></article>
        <article class="panel"><p class="eyebrow">Commission</p><h2>${money(data.commissionKobo)}</h2></article>
        <article class="panel"><p class="eyebrow">Commission of revenue</p><h2>${((data.commissionPercentOfRevenue || 0) * 100).toFixed(1)}%</h2></article>
        <article class="panel"><p class="eyebrow">Average purchase</p><h2>${money(data.averagePurchaseKobo)}</h2></article>
        <article class="panel"><p class="eyebrow">New vs returning purchases</p><h2>${data.newPurchases || 0} / ${data.returningPurchases || 0}</h2></article>
        <article class="panel"><p class="eyebrow">Conversion</p><h2>${Math.round((data.conversionRate || 0) * 100)}%</h2></article>
      </div>
      <article class="panel"><div style="display:flex;gap:6px;align-items:flex-end;overflow:auto">${bars || "<p>No commission activity in this range.</p>"}</div></article>
      <div class="dashboard-grid"><article class="panel"><h2>Top by revenue</h2><ul>${(data.topByRevenue || []).map((row) => `<li>${escapeHtml(row.name)} — ${money(row.revenueKobo)}</li>`).join("") || "<li>None</li>"}</ul></article>
      <article class="panel"><h2>Top by paying customers</h2><ul>${(data.topByCustomers || []).map((row) => `<li>${escapeHtml(row.name)} — ${row.payingCustomers}</li>`).join("") || "<li>None</li>"}</ul></article></div>`;
  }

  function bodyFor(data) {
    if (state.tab === "overview") return overview(data);
    if (state.tab === "partners") return `<div class="toolbar"><input id="affSearch" placeholder="Search name, email or code" value="${escapeHtml(state.search)}"></div>${partners(data.affiliates || [])}`;
    if (state.tab === "commissions") {
      const rows = data.commissions || [];
      if (!rows.length) return `<p class="empty-cell">No commissions yet.</p>`;
      return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Affiliate</th><th>Customer</th><th>Purchase</th><th>Commission</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.createdAt)}</td><td>${escapeHtml(row.affiliateId)}</td><td>${escapeHtml(row.maskedCustomer)}</td><td>${money(row.purchaseKobo)}</td><td>${money(row.amountKobo)}</td><td>${escapeHtml(row.status)}</td><td>${row.status !== "reversed" ? `<button class="secondary-button" type="button" data-refund="${escapeHtml(row.paymentTxId)}">Mark refunded</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    }
    if (state.tab === "withdrawals") return withdrawals(data.withdrawals || []);
    if (state.tab === "analytics") return analytics(data);
    if (state.tab === "settings") return settings(data);
    const audit = data.audit || [];
    if (!audit.length) return `<p class="empty-cell">No affiliate audit events yet.</p>`;
    return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Detail</th></tr></thead><tbody>${audit.map((row) => `<tr><td>${escapeHtml(row.at)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.actor)}</td><td>${escapeHtml(JSON.stringify(row.payload || {}))}</td></tr>`).join("")}</tbody></table></div>`;
  }

  async function load() {
    const root = document.getElementById(rootId);
    if (!root) return;
    state.loading = true;
    state.error = "";
    root.innerHTML = shell("");
    const path = {
      overview: "/api/admin-affiliates?view=overview",
      partners: `/api/admin-affiliates?view=affiliates&q=${encodeURIComponent(state.search)}`,
      commissions: "/api/admin-affiliates?view=commissions",
      withdrawals: `/api/admin-affiliates?view=withdrawals&status=${encodeURIComponent(state.status)}&q=${encodeURIComponent(state.search)}`,
      analytics: `/api/admin-affiliates?view=analytics&preset=${encodeURIComponent(state.preset)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`,
      settings: "/api/admin-affiliates?view=settings",
      audit: "/api/admin-affiliates?view=audit",
    }[state.tab];
    try {
      const data = await request(path);
      state.payload = data;
      state.role = data.role || state.role;
      state.loading = false;
      root.innerHTML = shell(bodyFor(data));
      const status = $("#affStatus");
      if (status) status.value = state.status;
    } catch (error) {
      state.loading = false;
      state.error = error.message || "Unable to load affiliate administration";
      root.innerHTML = shell("");
    }
  }

  async function act(action, body) {
    state.notice = "";
    state.error = "";
    try {
      await request("/api/admin-affiliates", { method: "POST", body: { action, ...body } });
      state.notice = "Saved.";
      await load();
    } catch (error) {
      state.error = error.message || "Unable to save";
      const root = document.getElementById(rootId);
      if (root && state.payload) root.innerHTML = shell(bodyFor(state.payload));
    }
  }

  document.addEventListener("click", (event) => {
    const root = document.getElementById(rootId);
    if (!root || !root.contains(event.target)) return;
    const tab = event.target.closest("[data-aff-tab]");
    if (tab) { state.tab = tab.dataset.affTab; state.search = ""; void load(); return; }
    const copy = event.target.closest("[data-copy]");
    if (copy) { void copyText(copy.dataset.copy, copy.dataset.copyLabel || "Detail"); return; }
    const preset = event.target.closest("[data-preset]");
    if (preset) { state.preset = preset.dataset.preset; void load(); return; }
    if (event.target.id === "affCustom") {
      state.preset = "custom";
      state.from = $("#affFrom")?.value || "";
      state.to = $("#affTo")?.value || "";
      void load();
      return;
    }
    if (event.target.id === "affExport") {
      const query = `/api/admin-affiliates?view=withdrawals-csv&status=${encodeURIComponent(state.status)}&q=${encodeURIComponent(state.search)}`;
      void request(query, { csv: true }).then((csv) => {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "morphly-affiliate-withdrawals.csv";
        link.click();
        URL.revokeObjectURL(url);
        state.notice = "Withdrawal CSV exported. This view was added to the audit log.";
        toast(state.notice);
      }).catch((error) => { state.error = error.message; });
      return;
    }
    const button = event.target.closest("[data-aff-action]");
    if (button) {
      const id = button.dataset.id;
      const action = button.dataset.affAction;
      if (action === "reject" || action === "suspend" || action === "activate" || action === "flag") {
        const reason = window.prompt("Reason for the audit log");
        if (!reason || reason.trim().length < 3) return;
        void act(action, { affiliateId: id, reason: reason.trim() });
        return;
      }
      if (action === "rate") {
        const rate = Number(window.prompt("Future commission rate in basis points (600 = 6%)"));
        if (!Number.isInteger(rate)) return;
        void act("rate", { affiliateId: id, rateBps: rate });
        return;
      }
      void act(action, { affiliateId: id });
      return;
    }
    const refund = event.target.closest("[data-refund]");
    if (refund) {
      const reason = window.prompt("Why is this payment marked refunded? This does not change the customer's credits.");
      if (!reason || reason.trim().length < 3) return;
      void act("refund", { paymentTxId: refund.dataset.refund, reason: reason.trim() });
      return;
    }
    const withdrawal = event.target.closest("[data-wd]");
    if (withdrawal) {
      const id = withdrawal.dataset.id;
      const action = withdrawal.dataset.wd;
      const ref = document.querySelector(`[data-ref-for="${CSS.escape(id)}"]`)?.value || "";
      if (action === "withdrawal-reject" || action === "withdrawal-fail") {
        const reason = window.prompt("Reason");
        if (!reason || reason.trim().length < 3) return;
        void act(action, { withdrawalId: id, reason: reason.trim() });
        return;
      }
      void act(action, { withdrawalId: id, transferRef: ref });
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target?.id === "affStatus") {
      state.status = event.target.value;
      void load();
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form?.id !== "affSettings") return;
    event.preventDefault();
    const settings = {
      registrationsEnabled: form.registrationsEnabled.checked,
      commissionsEnabled: form.commissionsEnabled.checked,
      manualAffiliateApproval: form.manualAffiliateApproval.checked,
      manualWithdrawalApproval: form.manualWithdrawalApproval.checked,
      defaultRateBps: Number(form.defaultRateBps.value),
      durationDays: Number(form.durationDays.value),
      maxDaysBeforeFirstPurchase: Number(form.maxDaysBeforeFirstPurchase.value),
      minWithdrawalKobo: Number(form.minWithdrawalKobo.value),
      holdDays: Number(form.holdDays.value),
      estimatedTransferFeeKobo: Number(form.estimatedTransferFeeKobo.value),
      transferFeePayer: form.transferFeePayer.value,
      autoPayoutsEnabled: false,
    };
    void act("settings", { settings });
  });

  window.MorphlyAffiliateAdmin = { render: load };
})();
