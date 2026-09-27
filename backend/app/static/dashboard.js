const state = {
  view: "overview",
  overview: null,
  pis: [],
  features: [],
  users: [],
  usage: [],
  models: [],
  selectedFeature: null,
  featureDetail: null,
  search: "",
  modelFilter: "all",
};

const viewInfo = {
  overview: ["Overview", "A clear view of AI credit consumption across your workspace."],
  initiatives: ["Initiatives", "Organize product areas and the features connected to them."],
  features: ["Features", "Compare feature-level usage and see who and what is driving it."],
  usage: ["Usage", "Review recent Copilot responses and their credit consumption."],
  people: ["People", "Manage the people associated with workspace usage."],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const number = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value || 0);
const credits = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value || 0);
const dateTime = (value) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const shortId = (value = "") => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload?.detail === "string" ? payload.detail : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function loadData() {
  const [overview, pis, features, users, usage, models] = await Promise.all([
    api("/analytics/overview"), api("/pis"), api("/features"), api("/users"), api("/usage?limit=100"), api("/analytics/models"),
  ]);
  Object.assign(state, { overview, pis, features, users, usage, models });
  updateConnection(true);
  if (state.selectedFeature && features.some((feature) => feature.feature_id === state.selectedFeature)) {
    await loadFeatureDetail(state.selectedFeature, false);
  }
  render();
}

function updateConnection(online, message) {
  const label = $("#connection-label");
  const status = label.parentElement;
  status.classList.toggle("is-online", online);
  status.classList.toggle("is-offline", !online);
  label.textContent = message || (online ? "API connected" : "API unavailable");
}

function showNotice(message) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.hidden = !message;
}

function setView(view) {
  state.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  render();
}

function setPageHeading() {
  const [title, description] = viewInfo[state.view];
  $("#page-title").textContent = title;
  $("#page-description").textContent = description;
  $("#breadcrumb-current").textContent = title.toUpperCase();
  $("#heading-action").innerHTML = state.view === "initiatives"
    ? '<button class="button button-primary" data-action="new-pi"><span aria-hidden="true">＋</span> New initiative</button>'
    : state.view === "people"
      ? '<button class="button button-primary" data-action="new-user"><span aria-hidden="true">＋</span> Add person</button>'
      : "";
}

function render() {
  setPageHeading();
  showNotice("");
  const root = $("#view-root");
  const templates = {
    overview: renderOverview,
    initiatives: renderInitiatives,
    features: renderFeatures,
    usage: renderUsage,
    people: renderPeople,
  };
  root.innerHTML = templates[state.view]();
}

function metricCard(label, value, caption, marker = true) {
  return `<article class="metric"><div class="metric-top"><span class="metric-label">${label}</span>${marker ? '<span class="metric-marker"></span>' : ""}</div><div class="metric-value">${value}</div><div class="metric-caption">${caption}</div></article>`;
}

function renderOverview() {
  const overview = state.overview;
  const ranked = [...(overview?.by_pi || [])].sort((a, b) => b.ai_credits - a.ai_credits);
  const maxCredits = Math.max(1, ...ranked.map((row) => row.ai_credits));
  const bars = ranked.length ? ranked.slice(0, 6).map((row) => `
    <div class="bar-row"><div class="bar-copy"><span>${escapeHtml(row.name)}</span><span>${credits(row.ai_credits)} credits</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, row.ai_credits / maxCredits * 100)}%"></div></div></div>`).join("")
    : '<div class="empty-state"><strong>No initiative usage yet</strong>Usage totals will appear here when events are associated with features.</div>';
  const models = state.models.length ? state.models.slice(0, 6).map((model) => `
    <div class="model-row"><span class="model-name" title="${escapeHtml(model.model || "Unknown model")}">${escapeHtml(model.model || "Unknown model")}</span><span class="model-count">${number(model.queries)} calls</span><span class="model-credits">${credits(model.ai_credits)}</span></div>`).join("")
    : '<div class="empty-state"><strong>No model data yet</strong>Model usage will show once events arrive.</div>';
  const recent = state.usage.slice(0, 6);
  return `<div class="metrics-grid">
    ${metricCard("TOTAL AI CREDITS", credits(overview?.total_ai_credits), "Across all tracked responses")}
    ${metricCard("TOKENS PROCESSED", number(overview?.total_tokens), "Input and output tokens")}
    ${metricCard("TOTAL QUERIES", number(overview?.total_queries), "Recorded Copilot responses")}
    ${metricCard("INITIATIVES", number(state.pis.length), `${state.features.length} tracked features`)}
  </div>
  <div class="dashboard-grid">
    <section class="panel"><div class="panel-heading"><h2>Credit use by initiative</h2><button class="text-link" data-view="initiatives">View initiatives ↗</button></div><div class="bar-list">${bars}</div></section>
    <section class="panel"><div class="panel-heading"><h2>Models</h2><span class="panel-meta">By request volume</span></div><div class="model-list">${models}</div></section>
    <section class="panel"><div class="panel-heading"><h2>Recent usage</h2><button class="text-link" data-view="usage">View all ↗</button></div>${recent.length ? usageTable(recent, false) : emptyTable("No usage recorded", "New Copilot responses will appear here.")}</section>
    <section class="panel"><div class="panel-heading"><h2>Workspace snapshot</h2><span class="panel-meta">Current records</span></div><div class="model-list">
      <div class="model-row"><span class="model-name">People</span><span class="model-count">${number(state.users.length)} registered</span><span class="model-credits">${number(state.usage.filter((item) => item.user_id).length)} active*</span></div>
      <div class="model-row"><span class="model-name">Features</span><span class="model-count">${number(state.features.length)} tracked</span><span class="model-credits">${number(state.pis.length)} initiatives</span></div>
      <div class="model-row"><span class="model-name">Latest response</span><span class="model-count">${state.usage[0] ? escapeHtml(dateTime(state.usage[0].created_at)) : "No activity"}</span><span class="model-credits">${state.usage[0] ? `${credits(state.usage[0].ai_credits)} credits` : "—"}</span></div>
    </div></section>
  </div>`;
}

function emptyTable(title, description) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${escapeHtml(description)}</div>`;
}

function usageTable(rows, full = true) {
  const users = new Map(state.users.map((user) => [user.user_id, user.username]));
  const features = new Map(state.features.map((feature) => [feature.feature_id, feature.name]));
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>RESPONSE</th><th>PERSON</th><th>FEATURE</th><th>MODEL</th><th>TOKENS</th><th>CREDITS</th>${full ? "<th>RECORDED</th>" : ""}</tr></thead><tbody>${rows.map((item) => `
    <tr><td class="mono" title="${escapeHtml(item.usage_id)}">${escapeHtml(shortId(item.usage_id))}</td><td>${escapeHtml(users.get(item.user_id) || "Unassigned")}</td><td>${escapeHtml(features.get(item.feature_id) || "Unassigned")}</td><td class="mono">${escapeHtml(item.model || "—")}</td><td class="mono">${number(item.input_tokens + item.output_tokens)}</td><td class="mono">${credits(item.ai_credits)}</td>${full ? `<td class="muted">${escapeHtml(dateTime(item.created_at))}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function renderInitiatives() {
  const rows = state.pis.map((pi) => {
    const features = state.features.filter((feature) => feature.pi_id === pi.pi_id);
    const summary = state.overview?.by_pi?.find((item) => item.pi_id === pi.pi_id);
    return `<tr><td><div class="table-primary">${escapeHtml(pi.name)}</div><div class="muted">${escapeHtml(pi.description || "No description")}</div></td><td>${number(features.length)} features</td><td class="mono">${credits(summary?.ai_credits)} credits</td><td class="muted">${escapeHtml(dateTime(pi.created_at))}</td><td><button class="row-button" data-action="new-feature" data-pi-id="${escapeHtml(pi.pi_id)}">＋ Add feature</button></td></tr>`;
  }).join("");
  return `<div class="section-stack"><section class="panel"><div class="panel-heading"><h2>Product initiatives</h2><span class="panel-meta">${number(state.pis.length)} total</span></div>${state.pis.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>INITIATIVE</th><th>FEATURES</th><th>AI CREDITS</th><th>CREATED</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyTable("Start with an initiative", "Create an initiative to group features and understand usage by product area.")}</section>
    <section class="panel"><div class="panel-heading"><h2>Features</h2><button class="text-link" data-view="features">Explore feature analytics ↗</button></div>${state.features.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>FEATURE</th><th>INITIATIVE</th><th>DESCRIPTION</th><th></th></tr></thead><tbody>${state.features.map((feature) => `<tr><td class="table-primary">${escapeHtml(feature.name)}</td><td>${escapeHtml(state.pis.find((pi) => pi.pi_id === feature.pi_id)?.name || "Unknown")}</td><td class="muted">${escapeHtml(feature.description || "—")}</td><td><button class="row-button" data-action="open-feature" data-feature-id="${escapeHtml(feature.feature_id)}">View ↗</button></td></tr>`).join("")}</tbody></table></div>` : emptyTable("No features yet", "Add a feature to an initiative to attribute usage.")}</section></div>`;
}

function renderFeatures() {
  const featureRows = state.features.map((feature) => {
    const initiative = state.pis.find((pi) => pi.pi_id === feature.pi_id)?.name || "Unknown";
    const detail = state.selectedFeature === feature.feature_id ? state.featureDetail : null;
    return `<tr><td class="table-primary">${escapeHtml(feature.name)}</td><td>${escapeHtml(initiative)}</td><td class="mono">${detail ? number(detail.metrics.queries) : "—"}</td><td class="mono">${detail ? credits(detail.metrics.ai_credits) : "—"}</td><td><button class="row-button" data-action="open-feature" data-feature-id="${escapeHtml(feature.feature_id)}">${state.selectedFeature === feature.feature_id ? "Selected" : "Inspect ↗"}</button></td></tr>`;
  }).join("");
  let detailPanel = "";
  const detail = state.featureDetail;
  if (detail) {
    const users = detail.users.filter((user) => user.total_queries > 0);
    const models = detail.models.length ? detail.models.map((model) => `<div class="model-row"><span class="model-name">${escapeHtml(model.model || "Unknown model")}</span><span class="model-count">${number(model.queries)} calls</span><span class="model-credits">${credits(model.ai_credits)}</span></div>`).join("") : emptyTable("No model breakdown", "Usage for this feature has not been attributed to a model.");
    detailPanel = `<div class="feature-detail"><section class="panel"><div class="panel-heading"><h2>${escapeHtml(detail.feature.name)} · usage</h2><span class="panel-meta">${escapeHtml(state.pis.find((pi) => pi.pi_id === detail.feature.pi_id)?.name || "")}</span></div><div class="detail-metrics"><div class="detail-metric"><span>AI CREDITS</span><strong>${credits(detail.metrics.ai_credits)}</strong></div><div class="detail-metric"><span>TOKENS</span><strong>${number(detail.metrics.total_tokens)}</strong></div><div class="detail-metric"><span>QUERIES</span><strong>${number(detail.metrics.queries)}</strong></div></div><div class="panel-heading"><h2>People</h2><span class="panel-meta">Usage by person</span></div>${users.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>PERSON</th><th>QUERIES</th><th>AI CREDITS</th></tr></thead><tbody>${users.map((user) => `<tr><td>${escapeHtml(user.username)}</td><td class="mono">${number(user.total_queries)}</td><td class="mono">${credits(user.ai_credits)}</td></tr>`).join("")}</tbody></table></div>` : emptyTable("No attributed people", "No usage is assigned to a person for this feature.")}</section><section class="panel"><div class="panel-heading"><h2>Model breakdown</h2><span class="panel-meta">For selected feature</span></div><div class="model-list">${models}</div></section></div>`;
  }
  return `<div class="section-stack"><section class="panel"><div class="panel-heading"><h2>Tracked features</h2><span class="panel-meta">Select a feature to inspect analytics</span></div>${state.features.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>FEATURE</th><th>INITIATIVE</th><th>QUERIES</th><th>AI CREDITS</th><th></th></tr></thead><tbody>${featureRows}</tbody></table></div>` : emptyTable("No features to analyze", "Create an initiative and add its first feature.")}</section>${detailPanel}</div>`;
}

function renderUsage() {
  const query = state.search.trim().toLowerCase();
  const users = new Map(state.users.map((user) => [user.user_id, user.username]));
  const features = new Map(state.features.map((feature) => [feature.feature_id, feature.name]));
  const filtered = state.usage.filter((item) => {
    const matchesModel = state.modelFilter === "all" || item.model === state.modelFilter;
    const haystack = [item.usage_id, item.model, users.get(item.user_id), features.get(item.feature_id)].join(" ").toLowerCase();
    return matchesModel && (!query || haystack.includes(query));
  });
  const options = [...new Set(state.usage.map((item) => item.model).filter(Boolean))].sort().map((model) => `<option value="${escapeHtml(model)}" ${state.modelFilter === model ? "selected" : ""}>${escapeHtml(model)}</option>`).join("");
  return `<section class="panel"><div class="toolbar"><div class="toolbar-left"><input class="search-field" id="usage-search" type="search" placeholder="Search response, person, feature…" value="${escapeHtml(state.search)}" aria-label="Search usage records" /></div><div class="toolbar-right"><select class="select-field" id="model-filter" aria-label="Filter by model"><option value="all">All models</option>${options}</select><span class="panel-meta">${number(filtered.length)} of ${number(state.usage.length)} loaded</span></div></div>${filtered.length ? usageTable(filtered) : emptyTable("No matching usage", state.usage.length ? "Try another search or model filter." : "Usage records will appear after Copilot activity is ingested.")}</section>`;
}

function renderPeople() {
  const userRows = state.users.map((user) => {
    const userUsage = state.usage.filter((item) => item.user_id === user.user_id);
    const totalCredits = userUsage.reduce((sum, item) => sum + item.ai_credits, 0);
    const tokens = userUsage.reduce((sum, item) => sum + item.input_tokens + item.output_tokens, 0);
    return `<tr><td><div class="table-primary">${escapeHtml(user.username)}</div><div class="mono muted">${escapeHtml(shortId(user.user_id))}</div></td><td>${number(userUsage.length)} loaded</td><td class="mono">${credits(totalCredits)}</td><td class="mono">${number(tokens)}</td><td class="muted">${escapeHtml(dateTime(user.created_at))}</td></tr>`;
  }).join("");
  return `<section class="panel"><div class="panel-heading"><h2>Workspace people</h2><span class="panel-meta">${number(state.users.length)} registered · usage totals from latest 100 records</span></div>${state.users.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>PERSON</th><th>RECENT QUERIES</th><th>RECENT CREDITS</th><th>RECENT TOKENS</th><th>JOINED</th></tr></thead><tbody>${userRows}</tbody></table></div>` : emptyTable("No people registered", "Add a person to make usage attribution easier.")}</section>`;
}

function field(name, label, type = "text", options = {}) {
  const required = options.required === false ? "" : "required";
  const placeholder = options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : "";
  if (type === "select") {
    const choices = options.choices || [];
    return `<div class="form-field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}" ${required}>${choices.map((choice) => `<option value="${escapeHtml(choice.value)}">${escapeHtml(choice.label)}</option>`).join("")}</select></div>`;
  }
  if (type === "textarea") return `<div class="form-field"><label for="field-${name}">${label}</label><textarea id="field-${name}" name="${name}" ${placeholder}></textarea></div>`;
  return `<div class="form-field"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" ${required} ${placeholder} /></div>`;
}

function openDialog(kind, piId) {
  const dialog = $("#form-dialog");
  const fields = $("#dialog-fields");
  const submit = $("#dialog-submit");
  if (kind === "pi") {
    $("#dialog-eyebrow").textContent = "INITIATIVES";
    $("#dialog-title").textContent = "New initiative";
    submit.textContent = "Create initiative";
    fields.innerHTML = field("name", "Initiative name", "text", { placeholder: "e.g. Developer productivity" }) + field("description", "Description", "textarea", { required: false });
  } else if (kind === "feature") {
    $("#dialog-eyebrow").textContent = "FEATURES";
    $("#dialog-title").textContent = "Add a feature";
    submit.textContent = "Create feature";
    const choices = state.pis.filter((pi) => !piId || pi.pi_id === piId).map((pi) => ({ value: pi.pi_id, label: pi.name }));
    fields.innerHTML = field("pi_id", "Initiative", "select", { choices }) + field("name", "Feature name", "text", { placeholder: "e.g. Inline suggestions" }) + field("description", "Description", "textarea", { required: false });
  } else {
    $("#dialog-eyebrow").textContent = "PEOPLE";
    $("#dialog-title").textContent = "Add a person";
    submit.textContent = "Add person";
    fields.innerHTML = field("username", "Username", "text", { placeholder: "e.g. alex@company.com" });
  }
  dialog.dataset.kind = kind;
  dialog.showModal();
  $("#dialog-fields input, #dialog-fields select")?.focus();
}

async function loadFeatureDetail(featureId, shouldRender = true) {
  state.selectedFeature = featureId;
  state.featureDetail = await api(`/analytics/feature/${encodeURIComponent(featureId)}`);
  if (shouldRender) render();
}

async function submitDialog(event) {
  event.preventDefault();
  const dialog = $("#form-dialog");
  const kind = dialog.dataset.kind;
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const endpoint = kind === "pi" ? "/pis" : kind === "feature" ? "/features" : "/users";
  try {
    $("#dialog-submit").disabled = true;
    await api(endpoint, { method: "POST", body: JSON.stringify(data) });
    dialog.close();
    await loadData();
    if (kind === "feature") setView("features");
    if (kind === "pi") setView("initiatives");
    if (kind === "user") setView("people");
  } catch (error) {
    showNotice(error.message);
  } finally {
    $("#dialog-submit").disabled = false;
  }
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const navButton = event.target.closest("[data-view]");
    if (navButton) { setView(navButton.dataset.view); return; }
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "new-pi") openDialog("pi");
      if (action.dataset.action === "new-feature") openDialog("feature", action.dataset.piId);
      if (action.dataset.action === "new-user") openDialog("user");
      if (action.dataset.action === "open-feature") {
        try {
          await loadFeatureDetail(action.dataset.featureId);
          setView("features");
        } catch (error) { showNotice(error.message); }
      }
    }
    if (event.target.closest("[data-close-dialog]")) $("#form-dialog").close();
  });
  $("#dialog-form").addEventListener("submit", submitDialog);
  $("#refresh-button").addEventListener("click", async () => {
    $("#view-root").innerHTML = '<div class="loading-state"><span class="spinner"></span>Refreshing workspace data</div>';
    try { await loadData(); } catch (error) { updateConnection(false); showNotice(error.message); }
  });
  $("#view-root").addEventListener("input", (event) => {
    if (event.target.id === "usage-search") { state.search = event.target.value; const cursor = event.target.selectionStart; render(); const input = $("#usage-search"); input.focus(); input.setSelectionRange(cursor, cursor); }
  });
  $("#view-root").addEventListener("change", (event) => {
    if (event.target.id === "model-filter") { state.modelFilter = event.target.value; render(); }
  });
}

$("#today-label").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
bindEvents();
loadData().catch((error) => {
  updateConnection(false);
  $("#view-root").innerHTML = `<div class="empty-state"><strong>Could not load workspace data</strong>${escapeHtml(error.message)}<br /><br /><button class="button button-quiet" id="retry-load">Try again</button></div>`;
  $("#view-root").addEventListener("click", (event) => { if (event.target.id === "retry-load") loadData().then(render).catch((retryError) => showNotice(retryError.message)); });
});