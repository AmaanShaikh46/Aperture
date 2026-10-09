/**
 * APERTURE - Shared utility helpers
 */

/** Generate a UUID v4 string. */
import * as bootstrap from 'bootstrap';
export function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Format an ISO timestamp into a short local time string (e.g. "14:32"). */
export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatMessageDay(iso) {
  if (!iso) return '';

  const d = new Date(iso);

  if (isNaN(d.getTime())) return '';

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';

  return d.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Format an ISO timestamp into a short date (e.g. "Aug 24"). */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) return formatTime(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Format a "last seen" timestamp into a human-readable relative string. */
export function formatLastSeen(iso) {
  if (!iso) return 'a while ago';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'a while ago';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Escape HTML to prevent injection when building strings. */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Get initials from a display name (max 2 chars). */
export function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Build a deterministic avatar background color from a string. */
export function avatarColor(seed) {
  const palette = [
    '#2563eb', '#0891b2', '#059669', '#d97706',
    '#dc2626', '#7c3aed', '#db2777', '#4f46e5',
  '#0d9488', '#65a30d',
  ];
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

/** Debounce a function by `wait` ms. */
export function debounce(fn, wait = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/** Simple sleep/promise delay. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a query-string param by name. */
export function queryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

/** Apply the stored theme (light/dark/system) to the document. */
export function applyTheme(theme) {
  const root = document.documentElement;
  const stored = theme || localStorage.getItem('aperture-theme') || 'system';
  localStorage.setItem('aperture-theme', stored);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = stored === 'dark' || (stored === 'system' && prefersDark);
  root.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
  root.setAttribute('data-aperture-theme', stored);
  window.dispatchEvent(new CustomEvent('aperture:theme-changed', { detail: { theme: stored, isDark } }));
}

/** Initialize theme from storage on load. */
export function initTheme() {
  applyTheme(localStorage.getItem('aperture-theme') || 'system');
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('aperture-theme') || 'system') === 'system') applyTheme('system');
  });
}

/** Show a Bootstrap toast by id (creates a toast container if needed). */
export function showToast(message, variant = 'primary', delay = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    container.style.zIndex = '1090';
    document.body.appendChild(container);
  }
  const id = `toast-${uuid()}`;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="${id}" class="toast align-items-center text-bg-${variant} border-0" role="alert" aria-live="assertive" aria-atomic="true">
      <div class="d-flex">
        <div class="toast-body">${escapeHtml(message)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
    </div>`;
  const el = wrapper.firstElementChild;
  container.appendChild(el);
  const toast = new bootstrap.Toast(el, { delay });
  toast.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

/** Safely parse JSON, returning fallback on error. */
export function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/** Check if the user prefers reduced motion. */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
