"use strict";

const CONFIG = {
  demoMode: false,
  apiBase: window.MORPHLY_API_BASE || window.location.origin,
  storageKey: "morphly-admin-demo-v2",
  endpoints: {
    overview: "/api/admin-overview", users: "/api/admin-users", addCredit: () => "/api/admin-users",
    updateStatus: () => "/api/admin-users", packages: "/api/admin-credit-packages",
    transactions: "/api/admin-transactions", logs: "/api/admin-logs", audit: "/api/admin-audit-log",
    me: "/api/admin-me", config: "/api/public-config"
  }
};

const initialUsers = [
  { id: "usr_1042", name: "Chinedu Okafor", email: "chinedu@example.com", status: "active", credits: 1280, spent: 174000, purchases: 6, lastActive: "4 min ago", joined: "14 Jun 2026", plan: "Creator", platform: "windows", source: "whatsapp", sessions: 41, successRate: 94 },
  { id: "usr_1038", name: "Amina Bello", email: "amina@example.com", status: "active", credits: 420, spent: 87000, purchases: 3, lastActive: "28 min ago", joined: "21 Jun 2026", plan: "Starter", platform: "windows", source: "referral", sessions: 19, successRate: 89 },
  { id: "usr_1029", name: "David Mensah", email: "david@example.com", status: "suspended", credits: 0, spent: 29000, purchases: 1, lastActive: "2 days ago", joined: "29 Jun 2026", plan: "Starter", platform: "web", source: "tiktok", sessions: 7, successRate: 43 },
  { id: "usr_1021", name: "Blessing Eze", email: "blessing@example.com", status: "active", credits: 3750, spent: 398800, purchases: 9, lastActive: "1 hr ago", joined: "4 Jul 2026", plan: "Pro", platform: "windows", source: "whatsapp", sessions: 73, successRate: 97 },
  { id: "usr_1017", name: "Kwame Asante", email: "kwame@example.com", status: "active", credits: 90, spent: 58000, purchases: 2, lastActive: "5 hrs ago", joined: "7 Jul 2026", plan: "Starter", platform: "android", source: "direct", sessions: 12, successRate: 67 },
  { id: "usr_1012", name: "Fatima Musa", email: "fatima@example.com", status: "active", credits: 860, spent: 116000, purchases: 4, lastActive: "Yesterday", joined: "9 Jul 2026", plan: "Creator", platform: "web", source: "referral", sessions: 28, successRate: 91 },
  { id: "usr_1008", name: "Samuel Adeyemi", email: "samuel@example.com", status: "active", credits: 210, spent: 29000, purchases: 1, lastActive: "Yesterday", joined: "11 Jul 2026", plan: "Starter", platform: "windows", source: "whatsapp", sessions: 8, successRate: 88 },
  { id: "usr_1003", name: "Grace Nwosu", email: "grace@example.com", status: "suspended", credits: 615, spent: 145000, purchases: 5, lastActive: "4 days ago", joined: "12 Jul 2026", plan: "Creator", platform: "windows", source: "tiktok", sessions: 32, successRate: 72 },
  { id: "usr_0998", name: "Musa Ibrahim", email: "musa@example.com", status: "active", credits: 1560, spent: 232000, purchases: 7, lastActive: "5 days ago", joined: "2 Jun 2026", plan: "Creator", platform: "windows", source: "whatsapp", sessions: 55, successRate: 92 },
  { id: "usr_0987", name: "Esther Udo", email: "esther@example.com", status: "active", credits: 75, spent: 29000, purchases: 1, lastActive: "6 days ago", joined: "27 May 2026", plan: "Starter", platform: "android", source: "direct", sessions: 6, successRate: 50 }
];

const initialAudit = [
  { id: "aud_3", userId: "usr_1042", time: "18 Jul 2026, 10:42", admin: "Lucky Samuel", action: "Added 500 credits", detail: "Customer support adjustment" },
  { id: "aud_2", userId: "usr_1029", time: "17 Jul 2026, 16:08", admin: "Lucky Samuel", action: "Suspended account", detail: "Payment dispute review" },
  { id: "aud_1", userId: "usr_1021", time: "17 Jul 2026, 12:31", admin: "System", action: "Purchase credited", detail: "2,000 credits · Flutterwave verified" }
];

const initialPackages = [
  { id: "pkg_starter", name: "Starter", description: "A low-cost first package", price: 9500, credits: 120, status: "active", featured: false, purchases: 31, createdAt: "10 Jun 2026" },
  { id: "pkg_creator", name: "Creator", description: "For regular Morphly creators", price: 29000, credits: 500, status: "active", featured: true, purchases: 24, createdAt: "10 Jun 2026" },
  { id: "pkg_pro", name: "Pro", description: "More credits for power users", price: 99700, credits: 2000, status: "active", featured: false, purchases: 9, createdAt: "12 Jun 2026" },
  { id: "pkg_reseller", name: "Reseller", description: "High-volume reseller allocation", price: 366400, credits: 10000, status: "draft", featured: false, purchases: 3, createdAt: "18 Jun 2026" }
];

let transactions = [
  { ref: "MOR-260718-0941", userId: "usr_1021", customer: "Blessing Eze", package: "Pro", amount: 99700, credits: 2000, status: "success", date: "18 Jul, 09:41" },
  { ref: "MOR-260718-0835", userId: "usr_1042", customer: "Chinedu Okafor", package: "Creator", amount: 29000, credits: 500, status: "success", date: "18 Jul, 08:35" },
  { ref: "MOR-260717-2212", userId: "usr_1012", customer: "Fatima Musa", package: "Creator", amount: 29000, credits: 500, status: "pending", date: "17 Jul, 22:12" },
  { ref: "MOR-260717-1930", userId: "usr_1008", customer: "Samuel Adeyemi", package: "Starter", amount: 9500, credits: 120, status: "success", date: "17 Jul, 19:30" },
  { ref: "MOR-260717-1622", userId: "usr_1029", customer: "David Mensah", package: "Starter", amount: 9500, credits: 120, status: "failed", date: "17 Jul, 16:22" },
  { ref: "MOR-260717-1418", userId: "usr_1038", customer: "Amina Bello", package: "Creator", amount: 29000, credits: 500, status: "success", date: "17 Jul, 14:18" }
];

let systemLogs = [
  { event: "WEBSOCKET_CONNECT_FAILED", platform: "android", user: "Multiple users", count: 64, severity: "critical", lastSeen: "3 min ago" },
  { event: "CLIENT_TOKEN_ISSUE_FAILED", platform: "windows", user: "usr_1038", count: 27, severity: "critical", lastSeen: "18 min ago" },
  { event: "PAYMENT_WEBHOOK_DELAYED", platform: "web", user: "usr_1012", count: 18, severity: "warning", lastSeen: "1 hr ago" },
  { event: "FIRST_FRAME_TIMEOUT", platform: "windows", user: "Multiple users", count: 13, severity: "warning", lastSeen: "2 hrs ago" },
  { event: "INSUFFICIENT_CREDIT", platform: "all", user: "Multiple users", count: 46, severity: "info", lastSeen: "4 hrs ago" },
  { event: "SESSION_DISCONNECTED", platform: "web", user: "usr_1012", count: 8, severity: "info", lastSeen: "Yesterday" }
];

const baseMetrics = {
  downloads: 684,
  signups: 372,
  activated: 213,
  buyers: 67,
  repeatBuyers: 24,
  revenue: 2987000,
  decartCost: 1075320,
  fees: 119480,
  refunds: 57000,
  advertising: 185000,
  sessions: 921,
  failedSessions: 128,
  crashes: 17,
  apiRequests: 46210,
  apiErrors: 1468
};

const state = {
  activeView: "overview",
  period: "30",
  platform: "all",
  source: "all",
  selectedUserId: null,
  users: [],
  audit: [],
  packages: []
};

const periodFactor = { "7": 0.24, "30": 1, "90": 2.72 };
const platformFactor = { all: 1, windows: 0.66, web: 0.23, android: 0.11 };
const sourceFactor = { all: 1, whatsapp: 0.58, tiktok: 0.18, referral: 0.16, direct: 0.08 };

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
const number = (value) => Math.round(value).toLocaleString("en-NG");
const money = (value) => `₦${Math.round(value).toLocaleString("en-NG")}`;
const percentage = (part, whole) => whole ? `${((part / whole) * 100).toFixed(1)}%` : "0%";
const initials = (name) => name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDemoState() {
  if (!CONFIG.demoMode) return;
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG.storageKey));
    state.users = Array.isArray(stored?.users) ? stored.users : clone(initialUsers);
    state.audit = Array.isArray(stored?.audit) ? stored.audit : clone(initialAudit);
    state.packages = Array.isArray(stored?.packages) ? stored.packages : clone(initialPackages);
  } catch {
    state.users = clone(initialUsers);
    state.audit = clone(initialAudit);
    state.packages = clone(initialPackages);
  }
}

function persistDemoState() {
  if (!CONFIG.demoMode) return;
  localStorage.setItem(CONFIG.storageKey, JSON.stringify({ users: state.users, audit: state.audit, packages: state.packages }));
}

const AdminAPI = {
  async request(path, options = {}) {
    const session = (await window.morphlySupabase.auth.getSession()).data.session;
    if (!session) throw new Error("Your admin session has expired.");
    const response = await fetch(`${CONFIG.apiBase}${path}`, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  },
  async addCredit(userId, amount, reason) {
    if (!CONFIG.demoMode) {
      return AdminAPI.request(CONFIG.endpoints.addCredit(userId), {
        method: "POST",
        body: JSON.stringify({ userId, amount, reason, idempotencyKey: crypto.randomUUID() })
      });
    }
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error("User not found.");
    user.credits += amount;
    state.audit.unshift({ id: `aud_${Date.now()}`, userId, time: "Just now", admin: "Lucky Samuel", action: `Added ${number(amount)} credits`, detail: reason });
    persistDemoState();
    return user;
  },

  async updateStatus(userId, status, reason) {
    if (!CONFIG.demoMode) {
      return AdminAPI.request(CONFIG.endpoints.updateStatus(userId), {
        method: "POST", body: JSON.stringify({ action: "status", userId, status, reason })
      });
    }
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error("User not found.");
    user.status = status;
    state.audit.unshift({ id: `aud_${Date.now()}`, userId, time: "Just now", admin: "Lucky Samuel", action: status === "suspended" ? "Suspended account" : "Restored account", detail: reason });
    persistDemoState();
    return user;
  },

  async createPackage(packageInput) {
    if (!CONFIG.demoMode) {
      return AdminAPI.request(CONFIG.endpoints.packages, { method: "POST", body: JSON.stringify(packageInput) });
    }
    if (packageInput.featured) state.packages.forEach((item) => { item.featured = false; });
    const packageRecord = {
      id: `pkg_${Date.now()}`,
      ...packageInput,
      purchases: 0,
      createdAt: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })
    };
    state.packages.unshift(packageRecord);
    state.audit.unshift({ id: `aud_${Date.now()}`, userId: null, time: "Just now", admin: "Lucky Samuel", action: `Created ${packageRecord.name} package`, detail: `${money(packageRecord.price)} · ${number(packageRecord.credits)} credits · ${packageRecord.status}` });
    persistDemoState();
    return packageRecord;
  },

  async updatePackageStatus(packageId, status) {
    if (!CONFIG.demoMode) {
      const packages = state.packages.map((pkg) => ({ id: pkg.id, name: pkg.name, description: pkg.description, credits: pkg.credits, priceNGN: pkg.price, status: pkg.id === packageId ? status : pkg.status, isActive: pkg.id === packageId ? status === "active" : pkg.status === "active", isRecommended: pkg.featured, sortOrder: pkg.sortOrder || 0 }));
      const data = await AdminAPI.request(CONFIG.endpoints.packages, {
        method: "PUT", body: JSON.stringify({ packages })
      });
      const updated = data.packages.find((pkg) => pkg.id === packageId);
      return { ...updated, price: updated.priceNGN, status: updated.isActive ? "active" : "paused" };
    }
    const packageRecord = state.packages.find((item) => item.id === packageId);
    if (!packageRecord) throw new Error("Package not found.");
    packageRecord.status = status;
    state.audit.unshift({ id: `aud_${Date.now()}`, userId: null, time: "Just now", admin: "Lucky Samuel", action: `${status === "active" ? "Activated" : "Paused"} ${packageRecord.name} package`, detail: `${money(packageRecord.price)} · ${number(packageRecord.credits)} credits` });
    persistDemoState();
    return packageRecord;
  }
};

function filteredMetrics() {
  const factor = periodFactor[state.period] * platformFactor[state.platform] * sourceFactor[state.source];
  const data = {};
  Object.entries(baseMetrics).forEach(([key, value]) => { data[key] = Math.max(0, Math.round(value * factor)); });
  data.grossProfit = data.revenue - data.decartCost - data.fees - data.refunds - data.advertising;
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
    metricCard("Downloads", number(data.downloads), `${number(data.signups)} created accounts`, "+12.4%", "↓"),
    metricCard("Activated users", number(data.activated), `${percentage(data.activated, data.signups)} of signups`, "+8.1%", "✓"),
    metricCard("Revenue", money(data.revenue), `${number(data.buyers)} paying customers`, "+16.7%", "₦"),
    metricCard("Real profit", money(data.grossProfit), "After API, fees, refunds and ads", data.grossProfit >= 0 ? "+9.3%" : "-9.3%", "↗")
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
  const scale = data.signups / baseMetrics.signups;
  const signups = [41, 55, 49, 63, 58, 71, 35].map((value) => Math.max(1, Math.round(value * scale)));
  const activated = [22, 31, 27, 39, 33, 42, 19].map((value) => Math.max(1, Math.round(value * scale)));
  const buyers = [7, 9, 8, 13, 11, 14, 5].map((value) => Math.max(1, Math.round(value * scale)));
  const width = 760;
  const height = 240;
  const padding = { top: 15, right: 18, bottom: 30, left: 42 };
  const maxValue = Math.max(...signups, ...activated, ...buyers) * 1.16;
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
  const labels = ["1 Jul", "5 Jul", "10 Jul", "15 Jul", "20 Jul", "25 Jul", "30 Jul"].map((label, index, list) => {
    const x = padding.left + ((width - padding.left - padding.right) * index) / (list.length - 1);
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
  const items = [
    ["Customer revenue", data.revenue],
    ["Decart usage", -data.decartCost],
    ["Payment fees", -data.fees],
    ["Refunds", -data.refunds],
    ["Advertising", -data.advertising],
    ["Real operating profit", data.grossProfit]
  ];
  $("#moneyBreakdown").innerHTML = items.map(([label, value]) => `<div class="money-row"><span>${escapeHtml(label)}</span><strong>${value < 0 ? "−" : ""}${money(Math.abs(value))}</strong></div>`).join("");
}

function renderAlerts(data) {
  const alerts = [
    { level: "critical", icon: "!", title: "Connection failures increased", detail: "Mostly Android WebSocket sessions", count: number(data.failedSessions) },
    { level: "warning", icon: "↻", title: "Signup-to-activation drop", detail: `${number(Math.max(0, data.signups - data.activated))} users never reached a first output`, count: percentage(data.activated, data.signups) },
    { level: "warning", icon: "₦", title: "Pending payment webhooks", detail: "Verify delayed transactions before granting credit", count: "18" }
  ];
  $("#alertList").innerHTML = alerts.map((alert) => `<div class="alert-item ${alert.level}"><span class="alert-icon">${alert.icon}</span><span><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.detail)}</small></span><span class="alert-count">${escapeHtml(alert.count)}</span></div>`).join("");
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

function renderTransactions() {
  const successful = transactions.filter((item) => item.status === "success");
  const revenue = successful.reduce((sum, item) => sum + item.amount, 0);
  const credits = successful.reduce((sum, item) => sum + item.credits, 0);
  $("#transactionMetrics").innerHTML = [
    metricCard("Successful payments", number(successful.length), `${transactions.length} total attempts`, "", "✓"),
    metricCard("Collected", money(revenue), "Verified customer revenue", "", "₦"),
    metricCard("Credits granted", number(credits), "From verified purchases", "", "+"),
    metricCard("Failed or pending", number(transactions.length - successful.length), "Requires payment review", "", "!")
  ].join("");
  $("#transactionTableBody").innerHTML = transactions.map((transaction) => `<tr><td><code>${escapeHtml(transaction.ref)}</code></td><td>${escapeHtml(transaction.customer)}</td><td>${escapeHtml(transaction.package)}</td><td><strong>${money(transaction.amount)}</strong></td><td>${number(transaction.credits)}</td><td>${escapeHtml(transaction.gateway || "-")}</td><td><span class="status-pill ${transaction.status}">${escapeHtml(transaction.status)}</span></td><td>${money(transaction.gatewayFee || 0)}</td><td>${escapeHtml(transaction.refundStatus || "none")}</td><td>${escapeHtml(transaction.date ? new Date(transaction.date).toLocaleString("en-NG") : "-")}</td></tr>`).join("");
}

function renderPackages() {
  const statusFilter = $("#packageStatusFilter").value;
  const packages = state.packages.filter((item) => statusFilter === "all" || item.status === statusFilter);
  const activePackages = state.packages.filter((item) => item.status === "active");
  const purchases = state.packages.reduce((sum, item) => sum + item.purchases, 0);
  const revenue = state.packages.reduce((sum, item) => sum + item.price * item.purchases, 0);
  const averagePerHundred = activePackages.length ? activePackages.reduce((sum, item) => sum + (item.price / item.credits) * 100, 0) / activePackages.length : 0;
  $("#sidebarPackageCount").textContent = number(activePackages.length);
  $("#packageMetrics").innerHTML = [
    metricCard("Active packages", number(activePackages.length), `${state.packages.length} packages created`, "", "▣"),
    metricCard("Package purchases", number(purchases), "Across current offers", "", "✓"),
    metricCard("Package revenue", money(revenue), "Lifetime sample revenue", "", "₦"),
    metricCard("Average price / 100", money(averagePerHundred), "Across active packages", "", "↗")
  ].join("");
  $("#packageTableBody").innerHTML = packages.length ? packages.map((item) => `<tr><td><div class="package-cell"><strong>${escapeHtml(item.name)}${item.featured ? '<span class="featured-badge">Recommended</span>' : ""}</strong><small>${escapeHtml(item.description || "No description")}</small></div></td><td><span class="status-pill ${item.status === "active" ? "success" : "pending"}">${escapeHtml(item.status)}</span></td><td><strong>${money(item.price)}</strong></td><td>${number(item.credits)}</td><td>${money((item.price / item.credits) * 100)}</td><td>${number(item.purchases)}</td><td><div class="row-actions"><button class="manage-button" type="button" data-toggle-package="${escapeHtml(item.id)}">${item.status === "active" ? "Pause" : "Activate"}</button></div></td></tr>`).join("") : `<tr><td class="empty-cell" colspan="7">No packages match this status.</td></tr>`;
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
  if (state.packages.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    error.textContent = "A package with this name already exists.";
    return;
  }
  try {
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
  const logs = systemLogs.filter((log) => severity === "all" || log.severity === severity).filter((log) => state.platform === "all" || log.platform === "all" || log.platform === state.platform);
  const total = logs.reduce((sum, log) => sum + log.count, 0);
  const critical = logs.filter((log) => log.severity === "critical").reduce((sum, log) => sum + log.count, 0);
  const data = filteredMetrics();
  $("#logMetrics").innerHTML = [
    metricCard("Logged events", number(total), "Grouped occurrences", "", "≡"),
    metricCard("Critical events", number(critical), "Requires investigation", "", "!"),
    metricCard("Session success", percentage(data.successfulSessions, data.sessions), `${number(data.sessions)} sessions`, "", "✓"),
    metricCard("API error rate", percentage(data.apiErrors, data.apiRequests), `${number(data.apiErrors)} errors`, "", "↯")
  ].join("");
  $("#logTableBody").innerHTML = logs.length ? logs.map((log) => `<tr><td><code>${escapeHtml(log.event)}</code></td><td>${escapeHtml(log.platform)}</td><td>${escapeHtml(log.user)}</td><td>${number(log.count)}</td><td><span class="status-pill ${log.severity}">${escapeHtml(log.severity)}</span></td><td>${escapeHtml(log.lastSeen)}</td></tr>`).join("") : `<tr><td class="empty-cell" colspan="6">No logs match this filter.</td></tr>`;
}

function renderDeveloper() {
  const requirements = [
    ["Decart written authorization", "Required before third-party integrations", "pending"],
    ["Morphly API keys", "Hash at rest and support rotation", "pending"],
    ["Prepaid credit reservation", "Prevent negative balances and duplicate billing", "pending"],
    ["Per-key rate limits", "Protect margin and stop abusive traffic", "pending"],
    ["Developer terms and moderation", "Required for acceptable and lawful use", "pending"]
  ];
  $("#developerRequirements").innerHTML = requirements.map(([title, detail, status]) => `<div class="requirement-row"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><span class="status-pill ${status}">${escapeHtml(status)}</span></div>`).join("");
}

function renderAll() {
  $("#sidebarUserCount").textContent = number(state.users.length);
  renderOverview();
  renderUsers();
  renderTransactions();
  renderPackages();
  renderLogs();
  renderDeveloper();
  $("#lastUpdated").textContent = "just now";
}

function setView(view) {
  state.activeView = view;
  const titles = { overview: "Business overview", users: "User management", transactions: "Transactions", packages: "Credit packages", logs: "System logs", developer: "Developer API" };
  $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $("#pageTitle").textContent = titles[view] || "Morphly admin";
  $("#sidebar").classList.remove("open");
  if (view === "users") renderUsers();
  if (view === "packages") renderPackages();
  if (view === "logs") renderLogs();
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
  const audit = state.audit.filter((item) => item.userId === user.id);
  $("[data-user-audit]", template).innerHTML = audit.length ? audit.map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.detail)}</p><small>${escapeHtml(item.time)} · ${escapeHtml(item.admin)}</small></div>`).join("") : `<p class="empty-cell">No account changes recorded.</p>`;
  const content = $("#drawerContent");
  content.replaceChildren(template);
  $("#drawerTitle").textContent = `Manage ${user.name}`;
  $("#creditForm").addEventListener("submit", handleAddCredit);
  $("#statusForm").addEventListener("submit", handleStatusChange);
  $("#drawerBackdrop").hidden = false;
  $("#userDrawer").classList.add("open");
  $("#userDrawer").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeUserDrawer() {
  $("#userDrawer").classList.remove("open");
  $("#userDrawer").setAttribute("aria-hidden", "true");
  $("#drawerBackdrop").hidden = true;
  document.body.style.overflow = "";
  state.selectedUserId = null;
}

async function handleAddCredit(event) {
  event.preventDefault();
  const error = $("#creditFormError");
  const amount = Math.floor(Number($("#creditAmount").value));
  const reason = $("#creditReason").value.trim();
  error.textContent = "";
  if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) {
    error.textContent = "Enter a credit amount between 1 and 1,000,000.";
    return;
  }
  if (reason.length < 3) {
    error.textContent = "Enter a clear reason for the audit log.";
    return;
  }
  try {
    const result = await AdminAPI.addCredit(state.selectedUserId, amount, reason);
    const user = state.users.find((item) => item.id === state.selectedUserId);
    user.credits = result.newCredits;
    showToast(`${number(amount)} credits added to ${user.name}. New balance: ${number(user.credits)}.`);
    renderAll();
    openUserDrawer(user.id);
  } catch (failure) {
    error.textContent = failure.message || "Unable to add credit.";
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
  const rows = [["User ID", "Name", "Email", "Status", "Credits", "Purchases", "Lifetime spent"]];
  state.users.forEach((user) => rows.push([user.id, user.name, user.email, user.status, user.credits, user.purchases, user.spent]));
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `morphly-users-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("User report exported.");
}

function bindEvents() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-go-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.goView)));
  $$("[data-period]").forEach((button) => button.addEventListener("click", () => {
    state.period = button.dataset.period;
    $$("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
    renderAll();
  }));
  $("#platformFilter").addEventListener("change", (event) => { state.platform = event.target.value; renderAll(); });
  $("#sourceFilter").addEventListener("change", (event) => { state.source = event.target.value; renderAll(); });
  $("#userSearch").addEventListener("input", renderUsers);
  $("#userStatusFilter").addEventListener("change", renderUsers);
  $("#packageStatusFilter").addEventListener("change", renderPackages);
  $("#packageForm").addEventListener("submit", handleCreatePackage);
  $("#packagePrice").addEventListener("input", updatePackagePreview);
  $("#packageCredits").addEventListener("input", updatePackagePreview);
  $("#logSeverityFilter").addEventListener("change", renderLogs);
  $("#closeDrawerButton").addEventListener("click", closeUserDrawer);
  $("#drawerBackdrop").addEventListener("click", closeUserDrawer);
  $("#menuButton").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#exportButton").addEventListener("click", exportReport);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeUserDrawer(); });
}

async function loadLiveData() {
  const requests = await Promise.allSettled([
    AdminAPI.request(CONFIG.endpoints.overview), AdminAPI.request(CONFIG.endpoints.users), AdminAPI.request(CONFIG.endpoints.packages),
    AdminAPI.request(CONFIG.endpoints.transactions), AdminAPI.request(CONFIG.endpoints.logs), AdminAPI.request(CONFIG.endpoints.audit)
  ]);
  const value = (index, fallback) => requests[index].status === "fulfilled" ? requests[index].value : fallback;
  const overview = value(0, {}), users = value(1, { users: [] }), packages = value(2, { packages: [] });
  const txs = value(3, { transactions: [] }), logs = value(4, { logs: [] }), audit = value(5, { entries: [] });
  const failures = requests.filter((result) => result.status === "rejected");
  if (failures.length) console.warn("Some admin sections could not be loaded", failures.map((failure) => failure.reason?.message));
  state.users = (users.users || []).map((u) => ({ ...u, lastActive: u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString("en-NG") : "Never", joined: u.createdAt ? new Date(u.createdAt).toLocaleDateString("en-NG") : "", plan: "Credits", platform: "windows", source: "direct", sessions: 0, successRate: 0 }));
  state.packages = (packages.packages || []).map((p) => ({ ...p, price: p.priceNGN, status: p.status || (p.isActive ? "active" : "paused"), featured: p.isRecommended || false, purchases: p.purchases || 0, createdAt: p.createdAt ? new Date(p.createdAt).toLocaleDateString("en-NG") : "" }));
  transactions = txs.transactions || [];
  systemLogs = (logs.logs || []).map((log) => ({ event: log.error_code, platform: log.platform || "all", user: log.user_id || "Multiple users", count: log.occurrences, severity: log.severity, lastSeen: new Date(log.last_seen_at).toLocaleString("en-NG") }));
  state.audit = audit.entries || [];
  Object.assign(baseMetrics, { revenue: overview.revenueNGN || 0, sessions: overview.activeSessions || 0 });
}

async function startAuthenticatedApp() {
  await loadLiveData();
  $("#loginGate").hidden = true;
  $("#loginGate").style.display = "none";
  $("#adminApp").hidden = false;
  bindEvents();
  renderAll();
}

async function init() {
  const response = await fetch(`${CONFIG.apiBase}${CONFIG.endpoints.config}`);
  const config = await response.json();
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("Supabase public configuration is missing.");
  window.morphlySupabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  const session = (await window.morphlySupabase.auth.getSession()).data.session;
  if (session) {
    try { const me = await AdminAPI.request(CONFIG.endpoints.me); if (me.isAdmin) { await startAuthenticatedApp(); return; } } catch (error) { $("#loginError").textContent = error.message; }
  }
  $("#adminLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault(); $("#loginError").textContent = "";
    const { error } = await window.morphlySupabase.auth.signInWithPassword({ email: $("#adminEmail").value, password: $("#adminPassword").value });
    if (error) { $("#loginError").textContent = error.message; return; }
    try { const me = await AdminAPI.request(CONFIG.endpoints.me); if (!me.isAdmin) throw new Error("Admin access required."); await startAuthenticatedApp(); }
    catch (appError) { $("#loginError").textContent = appError.message; }
  });
}

init().catch((error) => { $("#loginError").textContent = error.message; });
