/**
 * APERTURE - Central Configuration
 * All public client configuration lives here. No secrets.
 */

const APERTURE_CONFIG = {
  // Set to true to use isolated mock data instead of the real backend.
  USE_MOCK_API: true,

  // REST API base URL for the FastAPI backend.
  API_BASE_URL: 'http://localhost:8000',

  // WebSocket base URL for real-time events.
  WS_BASE_URL: 'ws://localhost:8000',

  // Environment label.
  ENVIRONMENT: 'development',

  // Supabase public client configuration (anon key only — no service-role key).
  SUPABASE: {
    URL: import.meta.env.VITE_SUPABASE_URL || '',
    PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '',
  },

  // WebRTC ICE server configuration.
  // TURN credentials are fetched at runtime from the backend via call-service.getIceServers().
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

// Freeze so config can't be accidentally mutated at runtime.
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
