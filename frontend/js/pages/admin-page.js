/**
 * APERTURE - Admin Page Module
 * Lightweight admin UI: Dashboard, Users, Reports, System Status.
 * The backend enforces admin authorization — the frontend does not implement security.
 */
import { USE_MOCK_API } from '../config.js';
import { mockAdminUsers, mockReports, mockSystemStatus } from '../mock/mock-data.js';
import { escapeHtml, formatDate } from '../utils.js';

let currentTab = 'dashboard';

/** Initialize the admin page. */
export async function initAdminPage(container) {
  renderShell(container);
  setupTabs();
  await loadTab('dashboard');
}

/** Render the page shell with tabs. */
function renderShell(container) {
  container.innerHTML = `
    <div class="admin-page">
      <div class="admin-header">
        <h2 class="h5 mb-3">Admin Console</h2>
        <ul class="nav nav-tabs admin-tabs" role="tablist">
          <li class="nav-item" role="presentation">
            <button class="nav-link active admin-tab-btn" data-tab="dashboard" role="tab" aria-selected="true">
              <i class="bi bi-speedometer2"></i> Dashboard
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link admin-tab-btn" data-tab="users" role="tab" aria-selected="false">
              <i class="bi bi-people"></i> Users
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link admin-tab-btn" data-tab="reports" role="tab" aria-selected="false">
              <i class="bi bi-flag"></i> Reports
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link admin-tab-btn" data-tab="status" role="tab" aria-selected="false">
              <i class="bi bi-activity"></i> System Status
            </button>
          </li>
        </ul>
      </div>
      <div class="admin-content" id="admin-content"></div>
    </div>`;
}

/** Setup tab switching. */
function setupTabs() {
  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      currentTab = tab;
      document.querySelectorAll('.admin-tab-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      loadTab(tab);
    });
  });
}

/** Load content for a tab. */
async function loadTab(tab) {
  const contentEl = document.getElementById('admin-content');
  contentEl.innerHTML = `<div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>`;
  try {
    switch (tab) {
      case 'dashboard': await renderDashboard(contentEl); break;
      case 'users': await renderUsers(contentEl); break;
      case 'reports': await renderReports(contentEl); break;
      case 'status': await renderSystemStatus(contentEl); break;
    }
  } catch (e) {
    contentEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Failed to load admin data.</p></div>`;
  }
}

/** Render the dashboard tab. */
async function renderDashboard(el) {
  let users, reports, status;
  if (USE_MOCK_API) {
    users = mockAdminUsers;
    reports = mockReports;
    status = mockSystemStatus;
  } else {
    // The backend would provide admin endpoints
    users = [];
    reports = [];
    status = {};
  }
  const activeUsers = users.filter((u) => u.status === 'active').length;
  const pendingReports = reports.filter((r) => r.status === 'pending').length;
  const operationalServices = Object.values(status).filter((s) => s === 'operational').length;
  const totalServices = Object.keys(status).length || 1;

  el.innerHTML = `
    <div class="admin-dashboard">
      <div class="row g-3 mb-4">
        <div class="col-6 col-md-3">
          <div class="stat-card">
            <div class="stat-icon"><i class="bi bi-people text-primary"></i></div>
            <div class="stat-value">${users.length}</div>
            <div class="stat-label">Total Users</div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="stat-card">
            <div class="stat-icon"><i class="bi bi-person-check text-success"></i></div>
            <div class="stat-value">${activeUsers}</div>
            <div class="stat-label">Active Users</div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="stat-card">
            <div class="stat-icon"><i class="bi bi-flag text-warning"></i></div>
            <div class="stat-value">${pendingReports}</div>
            <div class="stat-label">Pending Reports</div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="stat-card">
            <div class="stat-icon"><i class="bi bi-activity text-info"></i></div>
            <div class="stat-value">${operationalServices}/${totalServices}</div>
            <div class="stat-label">Services OK</div>
          </div>
        </div>
      </div>
      <div class="admin-card">
        <h3 class="h6 mb-3">Recent Activity</h3>
        <div class="admin-activity-list">
          <div class="admin-activity-item">
            <i class="bi bi-person-plus text-success"></i>
            <span>New user registered</span>
            <span class="text-muted small ms-auto">${formatDate(new Date().toISOString())}</span>
          </div>
          <div class="admin-activity-item">
            <i class="bi bi-flag text-warning"></i>
            <span>New report submitted</span>
            <span class="text-muted small ms-auto">${formatDate(new Date(Date.now() - 3600000).toISOString())}</span>
          </div>
          <div class="admin-activity-item">
            <i class="bi bi-shield-check text-primary"></i>
            <span>System health check passed</span>
            <span class="text-muted small ms-auto">${formatDate(new Date(Date.now() - 7200000).toISOString())}</span>
          </div>
        </div>
      </div>
    </div>`;
}

/** Render the users tab. */
async function renderUsers(el) {
  let users;
  if (USE_MOCK_API) {
    users = mockAdminUsers;
  } else {
    users = [];
  }
  el.innerHTML = `
    <div class="admin-card">
      <h3 class="h6 mb-3">Users (${users.length})</h3>
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td>${escapeHtml(u.displayName)}</td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="badge ${u.role === 'admin' ? 'text-bg-primary' : 'text-bg-secondary'}">${escapeHtml(u.role)}</span></td>
                <td><span class="badge ${u.status === 'active' ? 'text-bg-success' : 'text-bg-danger'}">${escapeHtml(u.status)}</span></td>
                <td class="text-muted small">${formatDate(u.createdAt)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/** Render the reports tab. */
async function renderReports(el) {
  let reports;
  if (USE_MOCK_API) {
    reports = mockReports;
  } else {
    reports = [];
  }
  if (!reports.length) {
    el.innerHTML = `<div class="empty-state"><i class="bi bi-flag"></i><p>No reports.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="admin-card">
      <h3 class="h6 mb-3">Reports (${reports.length})</h3>
      <div class="reports-list">
        ${reports.map((r) => `
          <div class="report-item">
            <div class="report-info">
              <div class="report-reason">${escapeHtml(r.reason)}</div>
              <div class="report-meta text-muted small">Reported ${formatDate(r.createdAt)}</div>
            </div>
            <span class="badge ${r.status === 'pending' ? 'text-bg-warning' : r.status === 'reviewing' ? 'text-bg-info' : 'text-bg-success'}">${escapeHtml(r.status)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

/** Render the system status tab. */
async function renderSystemStatus(el) {
  let status;
  if (USE_MOCK_API) {
    status = mockSystemStatus;
  } else {
    status = {};
  }
  el.innerHTML = `
    <div class="admin-card">
      <h3 class="h6 mb-3">System Status</h3>
      <div class="status-list">
        ${Object.entries(status).filter(([k]) => k !== 'lastIncident').map(([service, state]) => `
          <div class="status-item">
            <div class="status-service">
              <i class="bi ${state === 'operational' ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'}"></i>
              ${escapeHtml(service.charAt(0).toUpperCase() + service.slice(1))}
            </div>
            <span class="badge ${state === 'operational' ? 'text-bg-success' : 'text-bg-danger'}">${escapeHtml(state)}</span>
          </div>`).join('')}
      </div>
      ${status.lastIncident ? `<div class="status-incident text-muted small mt-3">Last incident: ${formatDate(status.lastIncident)}</div>` : ''}
    </div>`;
}

/** Clean up. */
export function destroyAdminPage() {}

export default { initAdminPage, destroyAdminPage };
