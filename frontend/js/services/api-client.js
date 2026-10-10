/**
 * APERTURE - Central REST API Client
 * All REST requests pass through this module.
 * Automatically attaches the Supabase access token when authenticated.
 */
import { API_BASE_URL } from '../config.js';
import { auth } from './auth-service.js';

/** Build the full URL for a path. */
function buildUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = API_BASE_URL.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

/** Centralized HTTP error handling. Returns a normalized Error with status + detail. */
function handleError(status, detail) {
  const messages = {
    400: 'Bad request. Please check your input.',
    401: 'Your session has expired. Please sign in again.',
    403: 'You do not have permission to do that.',
    404: 'The resource you are looking for was not found.',
    409: 'A conflict occurred with existing data.',
    422: 'The data you submitted was invalid.',
    429: 'Too many requests. Please slow down and try again.',
    500: 'Something went wrong on the server. Please try again.',
    502: 'The server is unavailable. Please try again shortly.',
    503: 'The service is temporarily unavailable.',
  };
  const err = new Error(detail || messages[status] || `Request failed (${status}).`);
  err.status = status;
  return err;
}

/** Core request function. */
export async function apiRequest(method, path, options = {}) {
  let url = buildUrl(path);
  const headers = {
    ...(options.headers || {}),
  };

  const isFormData =
    typeof FormData !== 'undefined' && options.body instanceof FormData;

  if (!isFormData && options.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
  }

  // Attach auth token if available.
  const token = await auth.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init = {
    method,
    headers,
    signal: options.signal,
  };

  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
  init.body =
    typeof options.body === 'string' || isFormData
      ? options.body
      : JSON.stringify(options.body);
  }

  if (options.query) {
    const qs = new URLSearchParams(options.query).toString();
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}${qs}`;
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw handleError(0, 'Network error. Please check your connection.');
  }

  if (res.status === 401) {
    // Session expired — notify the app.
    window.dispatchEvent(new CustomEvent('aperture:auth-expired'));
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const detail = data && (data.detail || data.message) ? (data.detail || data.message) : null;
    throw handleError(res.status, detail);
  }
  return data;
}

/** GET helper. */
export function get(path, options) {
  return apiRequest('GET', path, options);
}

/** POST helper. */
export function post(path, body, options) {
  return apiRequest('POST', path, { ...options, body });
}

/** PATCH helper. */
export function patch(path, body, options) {
  return apiRequest('PATCH', path, { ...options, body });
}

/** DELETE helper (named deleteRequest to avoid reserved word). */
export function deleteRequest(path, options) {
  return apiRequest('DELETE', path, options);
}

/** Health check. */
export function checkHealth() {
  return get('/api/health');
}

export default {
  apiRequest,
  get,
  post,
  patch,
  deleteRequest,
  checkHealth,
  getMyProfile,
};


export function getMyProfile() {
    return get('/api/v1/users/me');
}