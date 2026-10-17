/**
 * APERTURE - Central Configuration
 * Public client configuration only. Never put backend secrets here.
 *
 * Local development defaults to localhost:8000.
 * Production deployments should set VITE_API_BASE_URL in the frontend host.
 * VITE_WS_BASE_URL is optional: when omitted, it is derived from the API URL
 * (http -> ws, https -> wss) to avoid mismatched REST/WebSocket hosts.
 */

const viteEnv = import.meta.env;

function trimTrailingSlashes(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function isLoopbackPage() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

function deriveWebSocketBaseUrl(httpBaseUrl) {
  if (!httpBaseUrl) return '';
  try {
    const url = new URL(httpBaseUrl, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
    return trimTrailingSlashes(url.toString());
  } catch {
    return '';
  }
}

const isProductionBuild = Boolean(viteEnv.PROD);
const configuredApiBaseUrl = trimTrailingSlashes(viteEnv.VITE_API_BASE_URL || '');
const configuredWsBaseUrl = trimTrailingSlashes(viteEnv.VITE_WS_BASE_URL || '');

// Keep local development and localhost preview simple; hosted builds must set
// VITE_API_BASE_URL explicitly (for example, to the Render service URL).
const defaultApiBaseUrl = (!isProductionBuild || isLoopbackPage())
  ? 'http://localhost:8000'
  : '';

const apiBaseUrl = configuredApiBaseUrl || defaultApiBaseUrl;
const wsBaseUrl = configuredWsBaseUrl || deriveWebSocketBaseUrl(apiBaseUrl);
const environmentLabel = String(
  viteEnv.VITE_ENVIRONMENT || (isProductionBuild ? 'production' : 'development'),
).trim();

if (isProductionBuild && !configuredApiBaseUrl) {
  console.error(
    '[Aperture config] VITE_API_BASE_URL is missing. Set it to the HTTPS origin of the deployed FastAPI backend before deploying the frontend.',
  );
}

if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
  if (apiBaseUrl && apiBaseUrl.startsWith('http://')) {
    console.error('[Aperture config] An HTTPS page cannot reliably call an HTTP API. Use an https:// API URL.');
  }
  if (wsBaseUrl && wsBaseUrl.startsWith('ws://')) {
    console.error('[Aperture config] An HTTPS page requires a secure WebSocket URL (wss://).');
  }
}

const APERTURE_CONFIG = {
  // Set to true to use isolated mock data instead of the real backend.
  USE_MOCK_API: false,

  // REST API base URL; do not include the /api path suffix.
  API_BASE_URL: apiBaseUrl,

  // WebSocket server base URL; do not include the /ws path suffix.
  WS_BASE_URL: wsBaseUrl,

  // Environment label, useful for diagnostics.
  ENVIRONMENT: environmentLabel,

  // Supabase public client configuration. Never use a service-role/secret key here.
  SUPABASE: {
    URL: viteEnv.VITE_SUPABASE_URL || '',
    PUBLISHABLE_KEY: viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY || '',
  },

  // WebRTC ICE server configuration. TURN will be integrated in a separate step.
  ICE_SERVERS: [
    { urls: ['stun:stun.l.google.com:19302'] },
  ],

  // WebSocket reconnect settings.
  WS_RECONNECT: {
    INITIAL_DELAY: 1000,
    MAX_DELAY: 30000,
    BACKOFF_FACTOR: 1.5,
  },

  // App metadata.
  APP_NAME: 'APERTURE',
  APP_VERSION: '1.0.0',
};

Object.freeze(APERTURE_CONFIG);
Object.freeze(APERTURE_CONFIG.SUPABASE);
Object.freeze(APERTURE_CONFIG.ICE_SERVERS);
Object.freeze(APERTURE_CONFIG.WS_RECONNECT);

export const USE_MOCK_API = APERTURE_CONFIG.USE_MOCK_API;
export const API_BASE_URL = APERTURE_CONFIG.API_BASE_URL;
export const WS_BASE_URL = APERTURE_CONFIG.WS_BASE_URL;
export const ENVIRONMENT = APERTURE_CONFIG.ENVIRONMENT;
export const SUPABASE = APERTURE_CONFIG.SUPABASE;
export const ICE_SERVERS = APERTURE_CONFIG.ICE_SERVERS;
export const WS_RECONNECT = APERTURE_CONFIG.WS_RECONNECT;
export const APP_NAME = APERTURE_CONFIG.APP_NAME;
export const APP_VERSION = APERTURE_CONFIG.APP_VERSION;

export default APERTURE_CONFIG;
