"use strict";

const CONFIG = {
  apiBase: window.MORPHLY_API_BASE || window.location.origin,
  endpoints: {
    overview: "/api/admin-overview", users: "/api/admin-users", adjustCredit: () => "/api/admin-users",
    updateStatus: () => "/api/admin-users", packages: "/api/admin-credit-packages",
    transactions: "/api/admin-transactions", referrals: "/api/admin-referrals", usage: "/api/admin-usage", logs: "/api/admin-logs", audit: "/api/admin-audit-log",
    me: "/api/admin-me", config: "/api/public-config"
  }
};

let transactions = [];
let systemLogs = [];

const baseMetrics = {
  downloads: 0, signups: 0, activated: 0, buyers: 0, repeatBuyers: 0,
  revenue: 0, providerCost: 0, fees: 0, refunds: 0, advertising: 0,
  sessions: 0, failedSessions: 0, crashes: 0, apiRequests: 0, apiErrors: 0,
  growthSeries: []
};

const state = {
  activeView: "overview",
  period: "30",
  platform: "all",
  source: "all",
  loadedAt: null,
  loadErrors: {},
  currentAdmin: null,
  selectedUserId: null,
  userHistory: new Map(),
  creditOperation: null,
  creditSubmitting: false,
  editingPackageId: null,
  users: [],
  usage: { periodDays: 30, totals: {}, users: [], dataHealth: {} },
  referralData: { referrals: [], totals: {}, audit: [] },
  audit: [],
  packages: []
};

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
const number = (value) => Math.round(value).toLocaleString("en-NG");
const money = (value) => `₦${Math.round(value).toLocaleString("en-NG")}`;
const percentage = (part, whole) => whole ? `${((part / whole) * 100).toFixed(1)}%` : "0%";
const initials = (name) => name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);

const safeNumber = (value) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function parseTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectedCutoff() {
  const days = Number(state.period);
  return Date.now() - (Number.isFinite(days) ? days : 30) * 24 * 60 * 60 * 1000;
}

function isWithinSelectedPeriod(value) {
  const timestamp = parseTimestamp(value);
  return timestamp === null || timestamp >= selectedCutoff();
}

function matchesDimension(record, key) {
  const selected = state[key];
  if (selected === "all") return true;
  const directValue = String(record?.[key] || "").toLowerCase();
  if (directValue) return directValue === selected;
  const user = record?.userId ? state.users.find((item) => item.id === record.userId) : null;
  return String(user?.[key] || "").toLowerCase() === selected;
}

function isSuccessfulTransaction(transaction) {
  return ["success", "successful", "completed", "paid"].includes(String(transaction?.status || "").toLowerCase());
}

function isPurchaseTransaction(transaction) {
  const type = String(transaction?.type || transaction?.transactionType || transaction?.transaction_type || "").toLowerCase();
  if (type && type !== "null" && type !== "undefined") return ["credit", "credit_purchase", "purchase", "package_purchase", "payment"].includes(type);
  return safeNumber(transaction?.amount) > 0 && safeNumber(transaction?.credits) > 0;
}

function formatDateTime(value) {
  const timestamp = parseTimestamp(value);
  return timestamp === null ? "-" : new Date(timestamp).toLocaleString("en-NG");
}

function formatDuration(value) {
  const totalSeconds = Math.max(0, Math.round(safeNumber(value)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function normalizeTransaction(transaction) {
  const rawStatus = String(transaction.status || "pending").toLowerCase();
  const status = isSuccessfulTransaction({ status: rawStatus }) ? "success" : rawStatus;
  return {
    ...transaction,
    ref: transaction.ref || transaction.reference || transaction.transaction_reference || transaction.id || "-",
    userId: transaction.userId || transaction.user_id || null,
    type: transaction.type || transaction.transactionType || transaction.transaction_type || "",
    customer: transaction.customer || transaction.customerEmail || transaction.customer_email || transaction.user_email || transaction.userId || transaction.user_id || "Unknown customer",
    package: transaction.package || transaction.packageName || transaction.package_name_snapshot || transaction.description || "Credit purchase",
    amount: safeNumber(transaction.amount ?? transaction.amountNGN ?? transaction.amount_naira),
    credits: safeNumber(transaction.credits ?? transaction.creditsPurchased ?? transaction.package_credits_snapshot),
    gateway: transaction.gateway || transaction.paymentGateway || transaction.payment_gateway || "manual",
    gatewayFee: safeNumber(transaction.gatewayFee ?? transaction.gatewayFeeNGN ?? transaction.gateway_fee_ngn),
    refundStatus: transaction.refundStatus || transaction.refund_status || "none",
    platform: String(transaction.platform || "").toLowerCase(),
    source: String(transaction.source || transaction.acquisitionSource || transaction.acquisition_source || "").toLowerCase(),
    status,
    date: transaction.date || transaction.verifiedAt || transaction.verified_at || transaction.paidAt || transaction.paid_at || transaction.createdAt || transaction.created_at || null
  };
}

function normalizeSystemLog(log) {
  const rawSeverity = String(log.severity || "info").toLowerCase();
  const severity = ["fatal", "error", "critical"].includes(rawSeverity) ? "critical" : (["warn", "warning"].includes(rawSeverity) ? "warning" : "info");
  return {
    event: log.event || log.errorCode || log.error_code || log.event_name || "UNKNOWN_ERROR",
    platform: String(log.platform || "all").toLowerCase(),
    source: String(log.source || "unknown").toLowerCase(),
    recordSource: log.recordSource || log.record_source || "system",
    message: log.message || log.safeMessage || log.safe_message || "System event recorded",
    user: log.user || log.userId || log.user_id || "Multiple users",
    count: Math.max(1, Math.round(safeNumber(log.count ?? log.occurrences ?? 1))),
    severity,
    timestamp: log.timestamp || log.lastSeenAt || log.last_seen_at || log.createdAt || log.created_at || null
  };
}
function filteredTransactions() {
  return transactions
    .filter(isPurchaseTransaction)
    .filter((transaction) => isWithinSelectedPeriod(transaction.date))
    .filter((transaction) => matchesDimension(transaction, "platform") && matchesDimension(transaction, "source"))
    .slice()
    .sort((left, right) => (parseTimestamp(right.date) || 0) - (parseTimestamp(left.date) || 0));
}

function scopedEndpoint(path) {
  const url = new URL(path, CONFIG.apiBase);
  url.searchParams.set("days", state.period);
  if (state.platform !== "all") url.searchParams.set("platform", state.platform);
  if (state.source !== "all") url.searchParams.set("source", state.source);
  return url.pathname + url.search;
}
const AdminAPI = {
  async request(path, options = {}) {
    let accessToken = window.morphlyAccessToken;
    if (!accessToken) {
      const session = (await window.morphlySupabase.auth.getSession()).data.session;
      accessToken = session?.access_token;
      window.morphlyAccessToken = accessToken || null;
    }
    if (!accessToken) throw new Error("Your admin session has expired.");
    const response = await fetch(`${CONFIG.apiBase}${path}`, { ...options, cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  },
  async adjustCredit(userId, adjustment, reason, idempotencyKey) {
    return AdminAPI.request(CONFIG.endpoints.adjustCredit(userId), {
      method: "POST",
      body: JSON.stringify({ action: "credits", userId, adjustment, reason, idempotencyKey })
    });
  },
  async userHistory(userId, limit = 100) {
    const query = new URLSearchParams({ userId, limit: String(limit) });
    return AdminAPI.request(`${CONFIG.endpoints.audit}?${query.toString()}`);
  },
  async updateStatus(userId, status, reason) {
    return AdminAPI.request(CONFIG.endpoints.updateStatus(userId), {
      method: "POST", body: JSON.stringify({ action: "status", userId, status, reason })
    });
  },
  async createPackage(packageInput) {
    return AdminAPI.request(CONFIG.endpoints.packages, { method: "POST", body: JSON.stringify(packageInput) });
  },
  async updatePackage(packageId, packageInput) {
    const packages = state.packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.id === packageId ? packageInput.name : pkg.name,
      description: pkg.id === packageId ? packageInput.description : pkg.description,
      credits: pkg.id === packageId ? packageInput.credits : pkg.credits,
      priceNGN: pkg.id === packageId ? packageInput.price : pkg.price,
      status: pkg.id === packageId ? packageInput.status : pkg.status,
      isActive: (pkg.id === packageId ? packageInput.status : pkg.status) === "active",
      isRecommended: pkg.id === packageId ? packageInput.featured : (packageInput.featured ? false : pkg.featured),
      sortOrder: pkg.sortOrder || 0
    }));
    const data = await AdminAPI.request(CONFIG.endpoints.packages, { method: "PUT", body: JSON.stringify({ packages }) });
    const updated = data.packages.find((pkg) => pkg.id === packageId);
    return { ...updated, price: updated.priceNGN, featured: updated.isRecommended };
  },

  async updatePackageStatus(packageId, status) {
    const packages = state.packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      description: pkg.description,
      credits: pkg.credits,
      priceNGN: pkg.price,
      status: pkg.id === packageId ? status : pkg.status,
      isActive: pkg.id === packageId ? status === "active" : pkg.status === "active",
      isRecommended: pkg.featured,
      sortOrder: pkg.sortOrder || 0
    }));
    const data = await AdminAPI.request(CONFIG.endpoints.packages, {
      method: "PUT", body: JSON.stringify({ packages })
    });
    const updated = data.packages.find((pkg) => pkg.id === packageId);
    return { ...updated, price: updated.priceNGN, status: updated.isActive ? "active" : "paused" };
  },
  async reconcilePayment(transactionId, userId, packageId, reference) {
    return AdminAPI.request(CONFIG.endpoints.transactions, {
      method: "POST",
      body: JSON.stringify({ transactionId, userId, packageId, reference: reference || undefined })
    });
  },
  async disqualifyReferral(referralId, reason) {
    return AdminAPI.request(CONFIG.endpoints.referrals, {
      method: "POST",
      body: JSON.stringify({ referralId, reason })
    });
  }
};

function filteredMetrics() {
  const data = { ...baseMetrics };
  const selectedTransactions = filteredTransactions();
  const successful = selectedTransactions.filter(isSuccessfulTransaction);
  const purchaseCountByUser = new Map();
  successful.forEach((transaction) => {
    if (!transaction.userId) return;
    purchaseCountByUser.set(transaction.userId, (purchaseCountByUser.get(transaction.userId) || 0) + 1);
  });

  data.revenue = successful.reduce((sum, transaction) => sum + safeNumber(transaction.amount), 0);
  data.fees = successful.reduce((sum, transaction) => sum + safeNumber(transaction.gatewayFee), 0);
  data.refunds = successful
    .filter((transaction) => !["", "none", "not_refunded"].includes(String(transaction.refundStatus || "").toLowerCase()))
    .reduce((sum, transaction) => sum + safeNumber(transaction.amount), 0);
  data.buyers = purchaseCountByUser.size;
  data.repeatBuyers = [...purchaseCountByUser.values()].filter((count) => count > 1).length;

  const dimensionUsers = filteredUsers();
  const periodUsers = dimensionUsers.filter((user) => isWithinSelectedPeriod(user.createdAt));
  if (state.platform !== "all" || state.source !== "all" || periodUsers.length || state.period !== "30") {
    data.signups = periodUsers.length;
  }

  data.growthSeries = (Array.isArray(baseMetrics.growthSeries) ? baseMetrics.growthSeries : [])
    .filter((item) => isWithinSelectedPeriod(item.date));
  data.grossProfit = data.revenue - data.providerCost - data.fees - data.refunds - data.advertising;
  data.successfulSessions = Math.max(0, data.sessions - data.failedSessions);
  return data;
}
function filteredUsers() {
  return state.users.filter((user) => state.platform === "all" || user.platform === state.platform).filter((user) => state.source === "all" || user.source === state.source);
}

function metricCard(label, value, context, trend = "", icon = "↗") {
  const trendMarkup = trend ? `<strong class="${trend.startsWith("-") ? "negative" : "positive"}">${escapeHtml(trend)}</strong> ` : "";
  return `<article class="metric-card"><div class="metric-card-head"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-icon">${escapeHtml(icon)}</span></div><div><strong class="metric-value">${escapeHtml(value)}</strong><span class="metric-context">${trendMarkup}${escapeHtml(context)}</span></div></article>`;
}

function renderOverview() {
  const data = filteredMetrics();
  $("#overviewMetrics").innerHTML = [
    metricCard("Downloads", number(data.downloads), `${number(data.signups)} created accounts`, "", "↓"),
    metricCard("Activated users", number(data.activated), `${percentage(data.activated, data.signups)} of signups`, "", "✓"),
    metricCard("Revenue", money(data.revenue), `${number(data.buyers)} paying customers`, "", "₦"),
    metricCard("Recorded net", money(data.grossProfit), "Revenue minus recorded fees and refunds", "", "↗")
  ].join("");
  renderGrowthChart(data);
  renderFunnel(data);
  renderMoney(data);
  renderAlerts(data);
}

function points(values, width, height, padding, maxValue) {
  return values.map((value, index) => {
    const x = padding.left + ((width - padding.left - padding.right) * index) / Math.max(1, values.length - 1);
    const y = padding.top + (height - padding.top - padding.bottom) - (value / maxValue) * (height - padding.top - padding.bottom);
    return { x, y, value };
  });
}

function linePath(items) {
  return items.map((item, index) => `${index ? "L" : "M"}${item.x.toFixed(1)},${item.y.toFixed(1)}`).join(" ");
}

function renderGrowthChart(data) {
  const seriesData = Array.isArray(data.growthSeries) ? data.growthSeries : [];
  if (!seriesData.length) { $("#growthChart").innerHTML = '<p class="empty-cell">No analytics events have been recorded yet.</p>'; return; }
  const signups = seriesData.map((item) => Number(item.signups || 0));
  const activated = seriesData.map((item) => Number(item.activated || 0));
  const buyers = seriesData.map((item) => Number(item.buyers || 0));
  const width = 760;
  const height = 240;
  const padding = { top: 15, right: 18, bottom: 30, left: 42 };
  const maxValue = Math.max(1, ...signups, ...activated, ...buyers) * 1.16;
  const series = [
    { values: signups, color: "#e31b3d", fill: "#e31b3d" },
    { values: activated, color: "#3568d4", fill: "#3568d4" },
    { values: buyers, color: "#16845b", fill: "#16845b" }
  ];
  const grid = [0, 1, 2, 3].map((index) => {
    const y = padding.top + ((height - padding.top - padding.bottom) * index) / 3;
    const label = Math.round(maxValue * (1 - index / 3));
    return `<line class="chart-grid" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line><text class="chart-label" x="4" y="${y + 3}">${label}</text>`;
  }).join("");
  const labels = seriesData.map((item) => new Date(`${item.date}T00:00:00`).toLocaleDateString("en-NG", { day: "numeric", month: "short" })).map((label, index, list) => {
    const x = padding.left + ((width - padding.left - padding.right) * index) / Math.max(1, list.length - 1);
    return `<text class="chart-label" text-anchor="middle" x="${x}" y="232">${label}</text>`;
  }).join("");
  const lines = series.map((item) => {
    const plotted = points(item.values, width, height, padding, maxValue);
    const path = linePath(plotted);
    const areaPath = `${path} L${plotted[plotted.length - 1].x},${height - padding.bottom} L${plotted[0].x},${height - padding.bottom} Z`;
    const dots = plotted.map((point) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="4" fill="${item.color}"><title>${number(point.value)}</title></circle>`).join("");
    return `<path class="chart-area" fill="${item.fill}" d="${areaPath}"></path><path class="chart-line" stroke="${item.color}" d="${path}"></path>${dots}`;
  }).join("");
  $("#growthChart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${grid}${labels}${lines}</svg>`;
}

function renderFunnel(data) {
  const stages = [
    ["Downloads", data.downloads],
    ["Account created", data.signups],
    ["First successful output", data.activated],
    ["First purchase", data.buyers],
    ["Repeat purchase", data.repeatBuyers]
  ];
  $("#funnelChart").innerHTML = stages.map(([label, value]) => `<div class="funnel-row"><span>${escapeHtml(label)}</span><strong>${number(value)} · ${percentage(value, data.downloads)}</strong><div class="funnel-track"><div class="funnel-fill" style="width:${Math.min(100, (value / Math.max(1, data.downloads)) * 100)}%"></div></div></div>`).join("");
}

function renderMoney(data) {
  const items = [["Customer revenue", data.revenue], ["Recorded payment fees", -data.fees], ["Recorded refunds", -data.refunds], ["Recorded net", data.grossProfit]];
  $("#moneyBreakdown").innerHTML = items.map(([label, value]) => `<div class="money-row"><span>${escapeHtml(label)}</span><strong>${value < 0 ? "−" : ""}${money(Math.abs(value))}</strong></div>`).join("");
}

function renderAlerts(data) {
  const pendingPayments = filteredTransactions().filter((transaction) => transaction.status === "pending").length;
  const criticalErrors = systemLogs
    .filter((log) => log.severity === "critical" && isWithinSelectedPeriod(log.timestamp))
    .reduce((sum, log) => sum + safeNumber(log.count), 0);
  const alerts = [];
  if (data.failedSessions > 0) {
    alerts.push({ level: "critical", icon: "!", title: "Connection failures recorded", detail: "Failed sessions in the selected period", count: number(data.failedSessions) });
  }
  if (criticalErrors > 0) {
    alerts.push({ level: "critical", icon: "!", title: "Critical application errors", detail: "Grouped occurrences in the system log", count: number(criticalErrors) });
  }
  if (data.signups > data.activated) {
    alerts.push({ level: "warning", icon: "↻", title: "Users awaiting first output", detail: number(data.signups - data.activated) + " signups have not reached a first output", count: percentage(data.activated, data.signups) });
  }
  if (pendingPayments > 0) {
    alerts.push({ level: "warning", icon: "₦", title: "Pending payment records", detail: "Backend transactions still awaiting completion", count: number(pendingPayments) });
  }
  $("#alertList").innerHTML = alerts.length
    ? alerts.map((alert) => [
      '<div class="alert-item ', alert.level, '"><span class="alert-icon">', escapeHtml(alert.icon),
      "</span><span><strong>", escapeHtml(alert.title), "</strong><small>", escapeHtml(alert.detail),
      '</small></span><span class="alert-count">', escapeHtml(alert.count), "</span></div>"
    ].join("")).join("")
    : '<p class="empty-cell">No operational alerts were found in the loaded records.</p>';
}
function renderUsers() {
  const platformUsers = filteredUsers();
  const status = $("#userStatusFilter").value;
  const query = $("#userSearch").value.trim().toLowerCase();
  const users = platformUsers.filter((user) => status === "all" || user.status === status).filter((user) => !query || `${user.name} ${user.email} ${user.id}`.toLowerCase().includes(query));
  const active = platformUsers.filter((user) => user.status === "active").length;
  const suspended = platformUsers.length - active;
  const balances = platformUsers.reduce((sum, user) => sum + user.credits, 0);
  const revenue = platformUsers.reduce((sum, user) => sum + user.spent, 0);
  $("#userMetrics").innerHTML = [
    metricCard("Listed users", number(platformUsers.length), `${active} active accounts`, "", "◎"),
    metricCard("Suspended", number(suspended), "Access currently blocked", "", "!"),
    metricCard("Customer revenue", money(revenue), "Across filtered customers", "", "₦"),
    metricCard("Available credits", number(balances), "Total customer balances", "", "◫")
  ].join("");
  $("#userTableBody").innerHTML = users.length ? users.map((user) => `<tr><td><div class="user-cell"><span class="small-avatar">${initials(user.name)}</span><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)} · ${escapeHtml(user.id)}</small></span></div></td><td><span class="status-pill ${user.status}">${escapeHtml(user.status)}</span></td><td><strong>${number(user.credits)}</strong></td><td>${number(user.purchases)}</td><td>${money(user.spent)}</td><td>${escapeHtml(user.lastActive)}</td><td><button class="manage-button" type="button" data-manage-user="${escapeHtml(user.id)}">Manage</button></td></tr>`).join("") : `<tr><td class="empty-cell" colspan="7">No users match the selected filters.</td></tr>`;
  $("#userTableSummary").textContent = `Showing ${users.length} of ${platformUsers.length} users`;
  $$('[data-manage-user]').forEach((button) => button.addEventListener("click", () => openUserDrawer(button.dataset.manageUser)));
}

function renderUsage() {
  const usage = state.usage || {};
  const totals = usage.totals || {};
  const allUsers = Array.isArray(usage.users) ? usage.users : [];
  const query = $("#usageSearch").value.trim().toLowerCase();
  const risk = $("#usageRiskFilter").value;
  const users = allUsers.filter((user) => {
    if (risk === "flagged" && !user.suspicious) return false;
    if (risk === "active" && safeNumber(user.activeSessions) <= 0) return false;
    return !query || `${user.email || ""} ${user.userId || ""}`.toLowerCase().includes(query);
  });
  const walletCredits = allUsers.reduce((sum, user) => sum + safeNumber(user.walletCredits), 0);

  $("#sidebarUsageCount").textContent = number(allUsers.length);
  $("#usageMetrics").innerHTML = [
    metricCard("Credits spent", number(safeNumber(totals.recordedCredits)), "Confirmed Morphly AI usage", "", "AI"),
    metricCard("Generation time", formatDuration(totals.recordedSeconds), `${number(safeNumber(totals.sessions))} provider sessions`, "", "◷"),
    metricCard("Wallet credits", number(walletCredits), "Remaining across users listed below", "", "◫"),
    metricCard("Usage warnings", number(safeNumber(totals.usersWithUsageGaps)), `${number(safeNumber(totals.untrackedExposureCredits))} potential untracked credits`, "", "!")
  ].join("");

  const health = usage.dataHealth || {};
  const healthWarnings = [];
  if (health.analyticsAvailable === false) healthWarnings.push("analytics events are unavailable");
  if (health.walletLedgerAvailable === false) healthWarnings.push("wallet-ledger history is unavailable");
  if (health.tokenAuditEnabled === false) healthWarnings.push("older sessions predate provider-token auditing");
  const healthWarning = $("#usageDataHealthWarning");
  healthWarning.hidden = healthWarnings.length === 0;
  $("#usageDataHealthText").textContent = healthWarnings.length
    ? `${healthWarnings.join("; ")}. Recorded session usage is still shown where available.`
    : "";

  $("#usageTableBody").innerHTML = users.length ? users.map((user) => {
    const riskReasons = Array.isArray(user.suspiciousReasons) ? user.suspiciousReasons : [];
    const userLabel = user.email || user.userId || "Unknown user";
    const userId = user.userId || "-";
    const activeSessions = safeNumber(user.activeSessions);
    return [
      "<tr><td><div class=\"user-cell\"><span class=\"small-avatar\">", escapeHtml(initials(userLabel)),
      "</span><span><strong>", escapeHtml(userLabel), user.isAdmin ? " (admin)" : "",
      "</strong><small>", escapeHtml(userId), "</small></span></div></td>",
      "<td><strong class=\"usage-value\">", number(safeNumber(user.walletCredits)), " credits</strong><small class=\"usage-detail\">Current wallet balance</small></td>",
      "<td><strong class=\"usage-value\">", number(safeNumber(user.recordedCredits)), " credits</strong><small class=\"usage-detail\">Confirmed debit for this period</small></td>",
      "<td><strong class=\"usage-value\">", escapeHtml(formatDuration(user.recordedSeconds)), "</strong><small class=\"usage-detail\">Recorded generation time</small></td>",
      "<td><strong class=\"usage-value\">", number(safeNumber(user.sessions)), " sessions / ", number(safeNumber(user.tokenMints)), " tokens</strong><small class=\"usage-detail\">",
      activeSessions > 0 ? `${number(activeSessions)} currently active` : "No active sessions", "</small></td>",
      "<td><strong class=\"usage-value\">", escapeHtml(formatDuration(user.untrackedExposureSeconds)), "</strong><small class=\"usage-detail\">",
      number(safeNumber(user.untrackedExposureCredits)), " potential credits, not confirmed</small></td>",
      "<td>", escapeHtml(formatDateTime(user.lastActivityAt)), "</td>",
      "<td class=\"usage-risk\"><span class=\"status-pill ", user.suspicious ? "critical" : "success", "\">",
      user.suspicious ? "Flagged" : "Clear", "</span><small class=\"usage-detail\">",
      escapeHtml(riskReasons.join("; ") || "No usage anomaly detected"), "</small></td></tr>"
    ].join("");
  }).join("") : '<tr><td class="empty-cell" colspan="8">No AI usage matches the selected period and filters.</td></tr>';

  $("#usageTableSummary").textContent = `Showing ${users.length} of ${allUsers.length} users with AI activity`;
  $("#usagePeriodSummary").textContent = `Last ${safeNumber(usage.periodDays) || safeNumber(state.period)} days · updated ${formatDateTime(usage.asOf)}`;
}

function renderTransactions() {
  const visibleTransactions = filteredTransactions();
  const successful = visibleTransactions.filter(isSuccessfulTransaction);
  const revenue = successful.reduce((sum, item) => sum + safeNumber(item.amount), 0);
  const credits = successful.reduce((sum, item) => sum + safeNumber(item.credits), 0);
  $("#transactionMetrics").innerHTML = [
    metricCard("Successful payments", number(successful.length), visibleTransactions.length + " total attempts", "", "✓"),
    metricCard("Collected", money(revenue), "Verified customer revenue in selected period", "", "₦"),
    metricCard("Credits granted", number(credits), "From verified purchases in selected period", "", "+"),
    metricCard("Failed or pending", number(visibleTransactions.length - successful.length), "Requires payment review", "", "!")
  ].join("");
  $("#transactionTableBody").innerHTML = visibleTransactions.length
    ? visibleTransactions.map((transaction) => [
      "<tr><td><code>", escapeHtml(transaction.ref), "</code></td><td>", escapeHtml(transaction.customer),
      "</td><td>", escapeHtml(transaction.package), "</td><td><strong>", money(transaction.amount),
      "</strong></td><td>", number(transaction.credits), "</td><td>", escapeHtml(transaction.gateway || "-"),
      "</td><td><span class=\"status-pill ", escapeHtml(transaction.status), "\">", escapeHtml(transaction.status),
      "</span></td><td>", money(transaction.gatewayFee || 0), "</td><td>", escapeHtml(transaction.refundStatus || "none"),
      "</td><td>", escapeHtml(formatDateTime(transaction.date)), "</td></tr>"
    ].join("")).join("")
    : '<tr><td class="empty-cell" colspan="10">No transactions were recorded for the selected period and filters.</td></tr>';
}
function renderPackages() {
  const statusFilter = $("#packageStatusFilter").value;
  const packages = state.packages.filter((item) => statusFilter === "all" || item.status === statusFilter);
  const activePackages = state.packages.filter((item) => item.status === "active");
  const purchases = state.packages.reduce((sum, item) => sum + safeNumber(item.purchases), 0);
  const revenue = state.packages.reduce((sum, item) => sum + safeNumber(item.revenueNGN), 0);
  const averagePerHundred = activePackages.length ? activePackages.reduce((sum, item) => sum + (item.price / item.credits) * 100, 0) / activePackages.length : 0;
  $("#sidebarPackageCount").textContent = number(activePackages.length);
  $("#packageMetrics").innerHTML = [
    metricCard("Active packages", number(activePackages.length), `${state.packages.length} packages created`, "", "▣"),
    metricCard("Package purchases", number(purchases), "Across current offers", "", "✓"),
    metricCard("Package revenue", money(revenue), "Verified completed transactions", "", "₦"),
    metricCard("Average price / 100", money(averagePerHundred), "Across active packages", "", "↗")
  ].join("");
  $("#packageTableBody").innerHTML = packages.length ? packages.map((item) => `<tr><td><div class="package-cell"><strong>${escapeHtml(item.name)}${item.featured ? '<span class="featured-badge">Recommended</span>' : ""}</strong><small>${escapeHtml(item.description || "No description")}</small></div></td><td><span class="status-pill ${item.status === "active" ? "success" : "pending"}">${escapeHtml(item.status)}</span></td><td><strong>${money(item.price)}</strong></td><td>${number(item.credits)}</td><td>${money((item.price / item.credits) * 100)}</td><td>${number(item.purchases)}</td><td><div class="row-actions"><button class="manage-button" type="button" data-edit-package="${escapeHtml(item.id)}">Edit</button><button class="manage-button" type="button" data-toggle-package="${escapeHtml(item.id)}">${item.status === "active" ? "Pause" : "Activate"}</button></div></td></tr>`).join("") : `<tr><td class="empty-cell" colspan="7">No packages match this status.</td></tr>`;
  $$('[data-edit-package]').forEach((button) => button.addEventListener("click", () => beginPackageEdit(button.dataset.editPackage)));
  $$('[data-toggle-package]').forEach((button) => button.addEventListener("click", async () => {
    const item = state.packages.find((packageRecord) => packageRecord.id === button.dataset.togglePackage);
    if (!item) return;
    try {
      const updated = await AdminAPI.updatePackageStatus(item.id, item.status === "active" ? "paused" : "active");
      Object.assign(item, updated);
      showToast(`${updated.name} is now ${updated.status}.`);
      renderPackages();
    } catch (failure) {
      showToast(failure.message || "Unable to update package.");
    }
  }));
}

function populateReconciliationOptions() {
  const userSelect = $("#reconcileUserId");
  const packageSelect = $("#reconcilePackageId");
  userSelect.innerHTML = `<option value="">Select customer</option>${state.users.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.email)} · ${number(user.credits)} credits</option>`).join("")}`;
  packageSelect.innerHTML = `<option value="">Select package purchased</option>${state.packages.filter((pkg) => pkg.status === "active").map((pkg) => `<option value="${escapeHtml(pkg.id)}">${escapeHtml(pkg.name)} · ${money(pkg.price)} · ${number(pkg.credits)} credits</option>`).join("")}`;
}

async function handleReconcilePayment(event) {
  event.preventDefault();
  const error = $("#reconcilePaymentError");
  const button = event.submitter;
  error.textContent = "";
  button.disabled = true;
  button.textContent = "Verifying with Flutterwave…";
  try {
    const result = await AdminAPI.reconcilePayment(
      $("#reconcileTransactionId").value.trim(), $("#reconcileUserId").value,
      $("#reconcilePackageId").value, $("#reconcileReference").value.trim()
    );
    await loadLiveData();
    renderAll();
    event.target.reset();
    populateReconciliationOptions();
    showToast(result.duplicate ? "This payment was already credited." : `Payment verified. ${number(result.creditsAdded)} credits added.`);
  } catch (failure) {
    error.textContent = failure.message || "Payment could not be reconciled.";
  } finally {
    button.disabled = false;
    button.textContent = "Verify and credit wallet";
  }
}

function beginPackageEdit(packageId) {
  const item = state.packages.find((pkg) => pkg.id === packageId);
  if (!item) return;
  state.editingPackageId = item.id;
  $("#packageName").value = item.name;
  $("#packagePrice").value = item.price;
  $("#packageCredits").value = item.credits;
  $("#packageDescription").value = item.description || "";
  $("#packageStatus").value = item.status;
  $("#packageFeatured").checked = Boolean(item.featured);
  $("#packageFormTitle").textContent = `Edit ${item.name}`;
  $("#packageSubmitButton").textContent = "Save changes";
  $("#packageCancelButton").hidden = false;
  updatePackagePreview();
  $("#packageForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelPackageEdit() {
  state.editingPackageId = null;
  $("#packageForm").reset();
  $("#packageFormTitle").textContent = "Create credit package";
  $("#packageSubmitButton").textContent = "Create package";
  $("#packageCancelButton").hidden = true;
  $("#packageFormError").textContent = "";
  updatePackagePreview();
}

function updatePackagePreview() {
  const price = Number($("#packagePrice").value);
  const credits = Number($("#packageCredits").value);
  $("#packagePreview").querySelector("strong").textContent = price > 0 && credits > 0 ? money((price / credits) * 100) : "₦0";
}

async function handleCreatePackage(event) {
  event.preventDefault();
  const error = $("#packageFormError");
  const name = $("#packageName").value.trim();
  const price = Math.floor(Number($("#packagePrice").value));
  const credits = Math.floor(Number($("#packageCredits").value));
  const description = $("#packageDescription").value.trim();
  const status = $("#packageStatus").value;
  const featured = $("#packageFeatured").checked;
  error.textContent = "";
  if (name.length < 2) {
    error.textContent = "Enter a package name with at least two characters.";
    return;
  }
  if (!Number.isFinite(price) || price < 100 || price > 100000000) {
    error.textContent = "Enter a price between ₦100 and ₦100,000,000.";
    return;
  }
  if (!Number.isFinite(credits) || credits < 1 || credits > 10000000) {
    error.textContent = "Enter between 1 and 10,000,000 credits.";
    return;
  }
  if (state.packages.some((item) => item.id !== state.editingPackageId && item.name.toLowerCase() === name.toLowerCase())) {
    error.textContent = "A package with this name already exists.";
    return;
  }
  try {
    if (state.editingPackageId) {
      const item = state.packages.find((pkg) => pkg.id === state.editingPackageId);
      const updated = await AdminAPI.updatePackage(state.editingPackageId, { name, description, price, credits, status, featured });
      Object.assign(item, updated);
      showToast(`${updated.name} was updated.`);
      cancelPackageEdit();
      renderPackages();
      return;
    }
    const rawCreated = await AdminAPI.createPackage({ name, description, price, credits, status, featured });
    const created = { ...rawCreated, price: rawCreated.priceNGN, featured: rawCreated.isRecommended, purchases: 0, createdAt: rawCreated.createdAt ? new Date(rawCreated.createdAt).toLocaleDateString("en-NG") : "" };
    state.packages.unshift(created);
    showToast(`${created.name} was created at ${money(created.price)} for ${number(created.credits)} credits.`);
    event.target.reset();
    updatePackagePreview();
    renderPackages();
  } catch (failure) {
    error.textContent = failure.message || "Unable to create package.";
  }
}

function renderLogs() {
  const severity = $("#logSeverityFilter").value;
  const logs = systemLogs
    .filter((log) => severity === "all" || log.severity === severity)
    .filter((log) => state.platform === "all" || log.platform === "all" || log.platform === state.platform)
    .filter((log) => isWithinSelectedPeriod(log.timestamp))
    .slice()
    .sort((left, right) => (parseTimestamp(right.timestamp) || 0) - (parseTimestamp(left.timestamp) || 0));
  const total = logs.reduce((sum, log) => sum + safeNumber(log.count), 0);
  const critical = logs.filter((log) => log.severity === "critical").reduce((sum, log) => sum + safeNumber(log.count), 0);
  const data = filteredMetrics();
  $("#logMetrics").innerHTML = [
    metricCard("Logged events", number(total), "Grouped occurrences in selected period", "", "≡"),
    metricCard("Critical events", number(critical), "Requires investigation", "", "!"),
    metricCard("Session success", percentage(data.successfulSessions, data.sessions), number(data.sessions) + " sessions", "", "✓"),
    metricCard("API error rate", percentage(data.apiErrors, data.apiRequests), number(data.apiErrors) + " errors", "", "↯")
  ].join("");
  $("#logTableBody").innerHTML = logs.length
    ? logs.map((log) => [
      "<tr><td><code>", escapeHtml(log.event), "</code></td><td><strong>", escapeHtml(log.message),
      "</strong><small class=\"usage-detail\">", escapeHtml(`${log.recordSource} · ${log.source}`), "</small></td><td>", escapeHtml(log.platform),
      "</td><td>", escapeHtml(log.user), "</td><td>", number(log.count),
      "</td><td><span class=\"status-pill ", escapeHtml(log.severity), "\">", escapeHtml(log.severity),
      "</span></td><td>", escapeHtml(formatDateTime(log.timestamp)), "</td></tr>"
    ].join("")).join("")
    : '<tr><td class="empty-cell" colspan="7">No system events were recorded for the selected period and filters.</td></tr>';
}
function renderDeveloper() {
  const requirements = [
    ["Xmax temporary-key enforcement", "Permanent credentials remain server-side", "ready"],
    ["Morphly API keys", "Hash at rest and support rotation", "pending"],
    ["Prepaid credit reservation", "Prevent negative balances and duplicate billing", "pending"],
    ["Per-key rate limits", "Protect margin and stop abusive traffic", "pending"],
    ["Developer terms and moderation", "Required for acceptable and lawful use", "pending"]
  ];
  $("#developerRequirements").innerHTML = requirements.map(([title, detail, status]) => `<div class="requirement-row"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><span class="status-pill ${status}">${escapeHtml(status)}</span></div>`).join("");
}

function renderReferrals() {
  const totals = state.referralData.totals || {};
  const selectedStatus = $("#referralStatusFilter").value;
  const referrals = (state.referralData.referrals || []).filter((entry) => {
    if (selectedStatus === "all") return true;
    if (selectedStatus === "registered") return entry.status !== "disqualified";
    if (selectedStatus === "waiting") return entry.status === "registered";
    return entry.status === selectedStatus;
  });

  $("#sidebarReferralCount").textContent = number(totals.registrations || 0);
  $("#referralMetrics").innerHTML = [
    metricCard("Registrations", number(totals.registrations || 0), "Referral relationships", "", "+"),
    metricCard("Waiting for purchase", number(totals.waitingForPurchase || 0), "No qualifying purchase yet", "", "..."),
    metricCard("Referral credits issued", number(totals.referralCreditsIssued || 0), "Verified first purchases only", "", "+"),
    metricCard("Signup bonuses issued", number(totals.signupBonusesIssued || 0), `${number(totals.signupBonusCreditsIssued || 0)} credits`, "", "+")
  ].join("");

  $("#referralTableBody").innerHTML = referrals.length ? referrals.map((entry) => {
    const purchase = entry.firstQualifyingPurchase;
    const reward = entry.rewardTransaction;
    const flags = [
      entry.refundWarning ? '<span class="status-pill warning">Refund warning</span>' : "",
      entry.suspicious ? '<span class="status-pill error">Suspicious</span>' : "",
      ["registered", "qualified"].includes(entry.status)
        ? `<button class="manage-button" type="button" data-disqualify-referral="${escapeHtml(entry.id)}">Disqualify</button>`
        : ""
    ].filter(Boolean).join(" ") || "None";
    return `<tr><td><strong>${escapeHtml(entry.referralCodeUsed || "-")}</strong><small>${escapeHtml(entry.referrerEmail || "Deleted user")}</small></td><td>${escapeHtml(entry.referredEmail || "-")}</td><td>${escapeHtml(formatDateTime(entry.registeredAt))}</td><td><span class="status-pill ${entry.status === "rewarded" ? "success" : entry.status === "disqualified" ? "error" : "pending"}">${escapeHtml(entry.status)}</span></td><td>${purchase ? `<strong>${escapeHtml(purchase.reference || purchase.id)}</strong><small>${escapeHtml(purchase.package || "Credit package")}</small>` : "Waiting for first purchase"}</td><td>${reward ? `<strong>${escapeHtml(reward.reference || reward.id)}</strong><small>${number(reward.credits)} credits</small>` : "Not rewarded"}</td><td>${flags}</td></tr>`;
  }).join("") : '<tr><td class="empty-cell" colspan="7">No referral records match this filter.</td></tr>';

  const audit = state.referralData.audit || [];
  $("#referralAuditList").innerHTML = audit.length
    ? audit.slice(0, 50).map((entry) => (
      `<div class="audit-row"><span><strong>${escapeHtml(entry.action || "Referral event")}</strong><small>Referred user: ${escapeHtml(entry.referred_user_id || "Not applicable")}</small></span><small>${escapeHtml(formatDateTime(entry.created_at))}</small></div>`
    )).join("")
    : '<p class="empty-cell">No referral audit events have been recorded.</p>';
}

function renderAll() {
  $("#sidebarUserCount").textContent = number(state.users.length);
  renderOverview();
  renderUsers();
  renderUsage();
  renderReferrals();
  renderTransactions();
  renderPackages();
  renderLogs();
  renderDeveloper();
  populateReconciliationOptions();
  $("#lastUpdated").textContent = state.loadedAt ? state.loadedAt.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "not loaded";
}

function setView(view) {
  state.activeView = view;
  const titles = { overview: "Business overview", users: "User management", usage: "AI credits usage", referrals: "Referral program", transactions: "Transactions", packages: "Credit packages", logs: "System logs", developer: "Developer API" };
  $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $("#pageTitle").textContent = view === 'communications' ? 'Customer communications' : titles[view] || "Morphly admin";
  $("#sidebar").classList.remove("open");
  if (view === "users") renderUsers();
  if (view === "usage") renderUsage();
  if (view === "referrals") renderReferrals();
  if (view === "packages") renderPackages();
  if (view === "logs") renderLogs();
}

function normalizeUserHistoryEntry(entry) {
  return {
    id: entry.id || `${entry.source || "history"}:${entry.time || crypto.randomUUID()}`,
    action: entry.action || "Account activity",
    detail: entry.detail || "Account activity recorded",
    time: entry.time || entry.timestamp || entry.createdAt || entry.created_at || null,
    actor: entry.actor || entry.admin || entry.adminEmail || "Morphly",
    source: entry.source || "account"
  };
}

function accountCreatedHistoryEntry(user) {
  return normalizeUserHistoryEntry({
    id: `account:${user.id}`,
    action: "Account created",
    detail: `Morphly account registered for ${user.email || user.id}`,
    time: user.createdAt,
    actor: "Morphly",
    source: "auth"
  });
}

function renderUserHistory(userId) {
  if (state.selectedUserId !== userId) return;
  const container = $("[data-user-audit]", $("#drawerContent"));
  const user = state.users.find((item) => item.id === userId);
  if (!container || !user) return;

  const history = state.userHistory.get(userId);
  const entries = [accountCreatedHistoryEntry(user), ...(history?.entries || [])]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
    .sort((left, right) => (parseTimestamp(right.time) || 0) - (parseTimestamp(left.time) || 0));
  const missingSources = Object.entries(history?.dataHealth || {})
    .filter(([, available]) => available === false)
    .map(([source]) => source.replace(/Available$/, ""));
  const notices = [];
  if (!history || history.status === "loading") {
    notices.push('<p class="history-notice">Loading the latest account history...</p>');
  } else if (history.status === "error") {
    notices.push(`<p class="history-notice error">History could not be fully loaded: ${escapeHtml(history.error)}</p>`);
  } else if (history.dataHealth?.truncated) {
    notices.push('<p class="history-notice warning">This account has more history than can be shown at once. The newest events are displayed.</p>');
  } else if (missingSources.length) {
    notices.push(`<p class="history-notice warning">Some history sources are unavailable: ${escapeHtml(missingSources.join(", "))}.</p>`);
  }
  container.innerHTML = notices.join("") + entries.map((item) => (
    `<div class="timeline-item"><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.detail)}</p><small>${escapeHtml(formatDateTime(item.time))} &middot; ${escapeHtml(item.actor)}</small></div>`
  )).join("");
}

async function loadUserHistory(userId) {
  const previous = state.userHistory.get(userId);
  state.userHistory.set(userId, { ...previous, status: "loading" });
  renderUserHistory(userId);
  try {
    const result = await AdminAPI.userHistory(userId, 100);
    const entries = Array.isArray(result.entries) ? result.entries.map(normalizeUserHistoryEntry) : [];
    state.userHistory.set(userId, { status: "ready", entries, dataHealth: result.dataHealth || {} });
  } catch (error) {
    state.userHistory.set(userId, {
      ...previous,
      status: "error",
      entries: previous?.entries || [],
      error: error.message || "Unknown history error"
    });
  }
  renderUserHistory(userId);
}

function updateCreditAdjustmentUi() {
  const user = state.users.find((item) => item.id === state.selectedUserId);
  if (!user || !$("#creditAdjustmentMode")) return;
  const mode = $("#creditAdjustmentMode").value;
  const amount = Number($("#creditAmount").value);
  const validAmount = Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
  const projected = mode === "deduct" ? user.credits - validAmount : user.credits + validAmount;
  $("[data-projected-balance]").textContent = `${number(Math.max(0, projected))} credits`;
  $("#creditDeductionConfirmationRow").hidden = mode !== "deduct";
  $("#creditAmount").max = String(mode === "deduct" ? Math.max(1, user.credits) : 1000000);
  $("#creditSubmitButton").textContent = mode === "deduct" ? "Remove credits" : "Add credits";
  $("#creditSubmitButton").classList.toggle("deduct", mode === "deduct");
  $$('[data-credit-mode]').forEach((button) => {
    const active = button.dataset.creditMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setCreditMode(mode) {
  if (mode === "deduct" && state.currentAdmin?.role !== "super_admin") return;
  $("#creditAdjustmentMode").value = mode;
  $("#creditDeductionConfirmation").checked = false;
  $("#creditFormError").textContent = "";
  updateCreditAdjustmentUi();
}

function setCreditFormDisabled(disabled) {
  state.creditSubmitting = disabled;
  const form = $("#creditForm");
  if (form) $$("input, button", form).forEach((control) => { control.disabled = disabled; });
}

function creditOperationKey(userId, adjustment, reason) {
  const signature = JSON.stringify({ userId, adjustment, reason });
  if (!state.creditOperation || state.creditOperation.signature !== signature) {
    state.creditOperation = { signature, key: `admin:${crypto.randomUUID()}` };
  }
  return state.creditOperation.key;
}

function openUserDrawer(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  state.selectedUserId = userId;
  const template = $("#userDrawerTemplate").content.cloneNode(true);
  $("[data-user-initials]", template).textContent = initials(user.name);
  $("[data-user-name]", template).textContent = user.name;
  $("[data-user-email]", template).textContent = user.email;
  const status = $("[data-user-status]", template);
  status.className = `status-pill ${user.status}`;
  status.textContent = user.status;
  $("[data-user-balance]", template).textContent = `${number(user.credits)} credits`;
  const details = [
    ["User ID", user.id], ["Plan", user.plan], ["Platform", user.platform], ["Joined", user.joined],
    ["Lifetime spend", money(user.spent)], ["Purchases", number(user.purchases)], ["Sessions", number(user.sessions)], ["Success rate", `${user.successRate}%`]
  ];
  $("[data-user-details]", template).innerHTML = details.map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const actionTitle = $("[data-status-action-title]", template);
  const actionButton = $("[data-status-action-button]", template);
  actionTitle.textContent = user.status === "active" ? "Suspend this user" : "Restore this user";
  actionButton.textContent = user.status === "active" ? "Suspend user" : "Restore user";
  $("[data-user-audit]", template).innerHTML = '<p class="history-notice">Loading the latest account history...</p>';
  const content = $("#drawerContent");
  content.replaceChildren(template);
  $("#drawerTitle").textContent = `Manage ${user.name}`;
  $("#creditForm").addEventListener("submit", handleCreditAdjustment);
  $$('[data-credit-mode]').forEach((button) => button.addEventListener("click", () => setCreditMode(button.dataset.creditMode)));
  $("#creditAmount").addEventListener("input", updateCreditAdjustmentUi);
  if (state.currentAdmin?.role !== "super_admin") {
    $('[data-credit-mode="deduct"]').hidden = true;
  }
  setCreditMode("add");
  $("#statusForm").addEventListener("submit", handleStatusChange);
  $("#drawerBackdrop").hidden = false;
  $("#userDrawer").classList.add("open");
  $("#userDrawer").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  void loadUserHistory(userId);
}

function closeUserDrawer() {
  $("#userDrawer").classList.remove("open");
  $("#userDrawer").setAttribute("aria-hidden", "true");
  $("#drawerBackdrop").hidden = true;
  document.body.style.overflow = "";
  state.selectedUserId = null;
}

async function handleCreditAdjustment(event) {
  event.preventDefault();
  const error = $("#creditFormError");
  const amount = Number($("#creditAmount").value);
  const mode = $("#creditAdjustmentMode").value;
  const reason = $("#creditReason").value.trim();
  const user = state.users.find((item) => item.id === state.selectedUserId);
  error.textContent = "";
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
    error.textContent = "Enter a whole credit amount between 1 and 1,000,000.";
    return;
  }
  if (reason.length < 3 || reason.length > 240) {
    error.textContent = "Enter a clear reason between 3 and 240 characters.";
    return;
  }
  if (mode === "deduct" && state.currentAdmin?.role !== "super_admin") {
    error.textContent = "Only a super admin can remove credits.";
    return;
  }
  if (mode === "deduct" && amount > user.credits) {
    error.textContent = `This user only has ${number(user.credits)} credits.`;
    return;
  }
  if (mode === "deduct" && !$("#creditDeductionConfirmation").checked) {
    error.textContent = "Confirm this credit removal before continuing.";
    return;
  }
  const adjustment = mode === "deduct" ? -amount : amount;
  const idempotencyKey = creditOperationKey(user.id, adjustment, reason);
  try {
    setCreditFormDisabled(true);
    const result = await AdminAPI.adjustCredit(user.id, adjustment, reason, idempotencyKey);
    user.credits = safeNumber(result.newCredits);
    state.creditOperation = null;
    state.userHistory.delete(user.id);
    showToast(`${number(amount)} credits ${adjustment < 0 ? "removed from" : "added to"} ${user.name}. New balance: ${number(user.credits)}.`);
    renderAll();
    openUserDrawer(user.id);
  } catch (failure) {
    error.textContent = failure.message || "Unable to adjust credits.";
  } finally {
    setCreditFormDisabled(false);
  }
}

async function handleStatusChange(event) {
  event.preventDefault();
  const error = $("#statusFormError");
  const reason = $("#statusReason").value.trim();
  const confirmed = $("#statusConfirmation").checked;
  const user = state.users.find((item) => item.id === state.selectedUserId);
  error.textContent = "";
  if (reason.length < 3) {
    error.textContent = "Enter a clear reason for the audit log.";
    return;
  }
  if (!confirmed) {
    error.textContent = "Confirm that you understand the account-access change.";
    return;
  }
  try {
    const nextStatus = user.status === "active" ? "suspended" : "active";
    const result = await AdminAPI.updateStatus(user.id, nextStatus, reason);
    Object.assign(user, result);
    const updated = user;
    state.userHistory.delete(updated.id);
    showToast(`${updated.name} is now ${updated.status}.`);
    renderAll();
    openUserDrawer(updated.id);
  } catch (failure) {
    error.textContent = failure.message || "Unable to update user status.";
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => { toast.hidden = true; }, 4200);
}

function exportReport() {
  const exportingUsage = state.activeView === "usage";
  const rows = exportingUsage
    ? [["User ID", "Email", "Wallet credits", "Credits spent", "Generation seconds", "Sessions", "Token mints", "Active sessions", "Untracked seconds", "Potential untracked credits", "Last activity", "Risk reasons"]]
    : [["User ID", "Name", "Email", "Status", "Credits", "Purchases", "Lifetime spent"]];
  if (exportingUsage) {
    (state.usage.users || []).forEach((user) => rows.push([
      user.userId,
      user.email,
      safeNumber(user.walletCredits),
      safeNumber(user.recordedCredits),
      safeNumber(user.recordedSeconds),
      safeNumber(user.sessions),
      safeNumber(user.tokenMints),
      safeNumber(user.activeSessions),
      safeNumber(user.untrackedExposureSeconds),
      safeNumber(user.untrackedExposureCredits),
      user.lastActivityAt || "",
      (user.suspiciousReasons || []).join("; ")
    ]));
  } else {
    state.users.forEach((user) => rows.push([user.id, user.name, user.email, user.status, user.credits, user.purchases, user.spent]));
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `morphly-${exportingUsage ? "ai-usage" : "users"}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(exportingUsage ? "AI usage report exported." : "User report exported.");
}

function bindEvents() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-go-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.goView)));
  $$("[data-period]").forEach((button) => button.addEventListener("click", async () => {
    state.period = button.dataset.period;
    $$("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
    await loadLiveData();
    renderAll();
  }));
  $("#platformFilter").addEventListener("change", async (event) => {
    state.platform = event.target.value;
    await loadLiveData();
    renderAll();
  });
  $("#sourceFilter").addEventListener("change", async (event) => {
    state.source = event.target.value;
    await loadLiveData();
    renderAll();
  });
  $("#userSearch").addEventListener("input", renderUsers);
  $("#userStatusFilter").addEventListener("change", renderUsers);
  $("#usageSearch").addEventListener("input", renderUsage);
  $("#usageRiskFilter").addEventListener("change", renderUsage);
  $("#referralStatusFilter").addEventListener("change", renderReferrals);
  $("#referralTableBody").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-disqualify-referral]");
    if (!button) return;
    const referral = (state.referralData.referrals || []).find((entry) => entry.id === button.dataset.disqualifyReferral);
    if (!referral) return;

    const reason = window.prompt(`Why should the referral for ${referral.referredEmail} be disqualified?`);
    if (reason === null) return;
    if (reason.trim().length < 3) {
      showToast("Enter a disqualification reason of at least 3 characters.");
      return;
    }

    button.disabled = true;
    try {
      await AdminAPI.disqualifyReferral(referral.id, reason.trim());
      await loadLiveData();
      renderAll();
      showToast("Referral disqualified and recorded in the audit log.");
    } catch (error) {
      showToast(error.message || "Unable to disqualify referral.");
      button.disabled = false;
    }
  });
  $("#packageStatusFilter").addEventListener("change", renderPackages);
  $("#packageForm").addEventListener("submit", handleCreatePackage);
  $("#packageCancelButton").addEventListener("click", cancelPackageEdit);
  $("#packagePrice").addEventListener("input", updatePackagePreview);
  $("#packageCredits").addEventListener("input", updatePackagePreview);
  $("#logSeverityFilter").addEventListener("change", renderLogs);
  $("#closeDrawerButton").addEventListener("click", closeUserDrawer);
  $("#drawerBackdrop").addEventListener("click", closeUserDrawer);
  $("#menuButton").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#exportButton").addEventListener("click", exportReport);
  $("#reconcilePaymentForm").addEventListener("submit", handleReconcilePayment);
  $("#refreshDataButton").addEventListener("click", async () => {
    try {
      const result = await loadLiveData();
      renderAll();
      showToast(result.failures ? "Refresh completed, but some sections could not be loaded." : "Live data refreshed.");
    } catch (error) {
      showToast(error.message);
    }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeUserDrawer(); });
}

async function loadLiveData() {
  const definitions = [
    { key: "overview", path: scopedEndpoint(CONFIG.endpoints.overview) },
    { key: "users", path: scopedEndpoint(CONFIG.endpoints.users) },
    { key: "usage", path: scopedEndpoint(CONFIG.endpoints.usage) },
    { key: "referrals", path: CONFIG.endpoints.referrals },
    { key: "packages", path: CONFIG.endpoints.packages },
    { key: "transactions", path: scopedEndpoint(CONFIG.endpoints.transactions) },
    { key: "logs", path: scopedEndpoint(CONFIG.endpoints.logs) },
    { key: "audit", path: CONFIG.endpoints.audit }
  ];
  const requests = await Promise.allSettled(definitions.map((definition) => AdminAPI.request(definition.path)));
  const results = Object.fromEntries(definitions.map((definition, index) => [definition.key, requests[index]]));
  state.loadErrors = Object.fromEntries(
    definitions
      .filter((definition) => results[definition.key].status === "rejected")
      .map((definition) => [definition.key, results[definition.key].reason?.message || "Unknown API error"])
  );

  const warning = $("#liveDataWarning");
  const failures = Object.entries(state.loadErrors);
  warning.hidden = failures.length === 0;
  $("#liveDataWarningText").textContent = failures.map(([key, message]) => key + ": " + message).join(" | ");

  if (results.users.status === "fulfilled") {
    const records = Array.isArray(results.users.value?.users) ? results.users.value.users : [];
    state.users = records.map((user) => {
      const createdAt = user.createdAt || user.created_at || null;
      const lastSignInAt = user.lastSignInAt || user.last_sign_in_at || null;
      return {
        ...user,
        id: user.id || user.userId || user.user_id,
        name: user.name || user.email?.split("@")[0] || "User",
        email: user.email || "",
        credits: safeNumber(user.credits),
        purchases: safeNumber(user.purchases),
        spent: safeNumber(user.spent ?? user.revenueNGN ?? user.revenue_ngn),
        status: user.status || user.accountStatus || user.account_status || "active",
        createdAt,
        lastActive: lastSignInAt ? formatDateTime(lastSignInAt) : "Never",
        joined: createdAt ? new Date(createdAt).toLocaleDateString("en-NG") : "",
        plan: user.plan || "Credits",
        platform: String(user.platform || user.lastPlatform || user.last_platform || "unknown").toLowerCase(),
        source: String(user.source || user.acquisitionSource || user.acquisition_source || "unknown").toLowerCase(),
        sessions: safeNumber(user.sessions),
        successRate: safeNumber(user.successRate ?? user.success_rate)
      };
    });
  }

  if (results.usage.status === "fulfilled") {
    const usage = results.usage.value || {};
    state.usage = {
      ...usage,
      periodDays: safeNumber(usage.periodDays) || safeNumber(state.period),
      totals: usage.totals || {},
      users: Array.isArray(usage.users) ? usage.users : [],
      dataHealth: usage.dataHealth || {}
    };
  }

  if (results.referrals.status === "fulfilled") {
    state.referralData = results.referrals.value || { referrals: [], totals: {}, audit: [] };
  }

  if (results.packages.status === "fulfilled") {
    const records = Array.isArray(results.packages.value?.packages) ? results.packages.value.packages : [];
    state.packages = records.map((pkg) => ({
      ...pkg,
      price: safeNumber(pkg.priceNGN ?? pkg.price_ngn ?? pkg.price),
      credits: safeNumber(pkg.credits),
      status: pkg.status || (pkg.isActive || pkg.is_active ? "active" : "paused"),
      featured: Boolean(pkg.isRecommended ?? pkg.is_recommended ?? pkg.featured),
      purchases: safeNumber(pkg.purchases),
      revenueNGN: safeNumber(pkg.revenueNGN ?? pkg.revenue_ngn),
      createdAt: pkg.createdAt || pkg.created_at ? new Date(pkg.createdAt || pkg.created_at).toLocaleDateString("en-NG") : ""
    }));
  }

  if (results.transactions.status === "fulfilled") {
    const records = Array.isArray(results.transactions.value?.transactions) ? results.transactions.value.transactions : [];
    transactions = records.map(normalizeTransaction)
      .sort((left, right) => (parseTimestamp(right.date) || 0) - (parseTimestamp(left.date) || 0));
  }

  if (results.logs.status === "fulfilled") {
    const records = Array.isArray(results.logs.value?.logs) ? results.logs.value.logs : [];
    systemLogs = records.map(normalizeSystemLog)
      .sort((left, right) => (parseTimestamp(right.timestamp) || 0) - (parseTimestamp(left.timestamp) || 0));
  }

  if (results.audit.status === "fulfilled") {
    const records = Array.isArray(results.audit.value?.entries) ? results.audit.value.entries : [];
    state.audit = records.map((entry) => ({
      ...entry,
      userId: entry.userId || entry.user_id || (entry.target_type === "user" ? entry.target_id : null),
      time: formatDateTime(entry.time || entry.timestamp || entry.createdAt || entry.created_at),
      admin: entry.admin || entry.adminEmail || entry.admin_email || entry.admin_user_id || "Administrator",
      action: entry.action || "admin.action",
      detail: entry.detail || entry.reason || entry.target_type || ""
    }));
  }

  if (results.overview.status === "fulfilled") {
    const overview = results.overview.value || {};
    Object.assign(baseMetrics, {
      downloads: safeNumber(overview.downloads),
      signups: safeNumber(overview.signups ?? overview.totalUsers),
      activated: safeNumber(overview.activated ?? overview.activatedUsers),
      buyers: safeNumber(overview.buyers),
      repeatBuyers: safeNumber(overview.repeatBuyers),
      revenue: safeNumber(overview.revenue ?? overview.revenueNGN),
      providerCost: safeNumber(overview.providerCost ?? overview.xmaxCost ?? overview.decartCost),
      fees: safeNumber(overview.fees ?? overview.gatewayFeesNGN),
      refunds: safeNumber(overview.refunds ?? overview.refundsNGN),
      advertising: safeNumber(overview.advertising ?? overview.advertisingNGN),
      sessions: safeNumber(overview.sessions),
      failedSessions: safeNumber(overview.failedSessions),
      crashes: safeNumber(overview.crashes),
      apiRequests: safeNumber(overview.apiRequests),
      apiErrors: safeNumber(overview.apiErrors),
      growthSeries: Array.isArray(overview.growthSeries) ? overview.growthSeries : []
    });
  }

  if (requests.some((result) => result.status === "fulfilled")) state.loadedAt = new Date();
  return { failures: failures.length };
}
async function startAuthenticatedApp() {
  $("#loginGate").hidden = true;
  $("#loginGate").style.display = "none";
  $("#adminApp").hidden = false;
  bindEvents();
  await loadLiveData();
  renderAll();
  window.clearInterval(startAuthenticatedApp.refreshTimer);
  startAuthenticatedApp.refreshTimer = window.setInterval(async () => {
    try { await loadLiveData(); renderAll(); }
    catch (error) { console.error("Automatic live-data refresh failed", error); }
  }, 30000);
}

async function init() {
  const response = await fetch(`${CONFIG.apiBase}${CONFIG.endpoints.config}`);
  const config = await response.json();
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("Supabase public configuration is missing.");
  window.morphlySupabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const session = (await window.morphlySupabase.auth.getSession()).data.session;
  window.morphlyAccessToken = session?.access_token || null;
  window.morphlySupabase.auth.onAuthStateChange((_event, nextSession) => {
    window.morphlyAccessToken = nextSession?.access_token || null;
  });
  if (session) {
    try { const me = await AdminAPI.request(CONFIG.endpoints.me); if (me.isAdmin) { state.currentAdmin = me; await startAuthenticatedApp(); return; } } catch (error) { $("#loginError").textContent = error.message; }
  }
  $("#adminLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault(); $("#loginError").textContent = "";
    const { data, error } = await window.morphlySupabase.auth.signInWithPassword({ email: $("#adminEmail").value, password: $("#adminPassword").value });
    if (error) { $("#loginError").textContent = error.message; return; }
    window.morphlyAccessToken = data.session?.access_token || null;
    try { const me = await AdminAPI.request(CONFIG.endpoints.me); if (!me.isAdmin) throw new Error("Admin access required."); state.currentAdmin = me; await startAuthenticatedApp(); }
    catch (appError) { $("#loginError").textContent = appError.message; }
  });
  $("#adminForgotPassword").addEventListener("click", async () => {
    const button = $("#adminForgotPassword");
    if (button.disabled) return;
    const email = $("#adminEmail").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("#loginError").textContent = "Enter a valid email address first."; return; }
    button.disabled = true;
    $("#loginError").textContent = "Sending reset email…";
    try {
      const { error } = await window.morphlySupabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
      if (error) throw error;
      $("#loginError").textContent = "If an account exists for this email, you will receive a reset link. Check your inbox and spam folder.";
    } catch (error) { $("#loginError").textContent = error.message || "Unable to send the reset request. Please try again."; }
    finally { button.disabled = false; }
  });
}

init().catch((error) => { $("#loginError").textContent = error.message; });
