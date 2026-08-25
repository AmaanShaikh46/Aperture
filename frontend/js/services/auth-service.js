/**
 * APERTURE - Authentication Service (Supabase Auth)
 * Wraps Supabase auth so the rest of the app never touches Supabase directly.
 */
import { SUPABASE } from '../config.js';
import { createClient } from '@supabase/supabase-js';

let supabase = null;

/** Lazily create the Supabase client. */
function getSupabase() {
  if (!supabase) {
    if (!SUPABASE.URL || !SUPABASE.ANON_KEY) {
      console.warn('[auth] Supabase URL/key not configured — auth will not function.');
      return null;
    }
    supabase = createClient(SUPABASE.URL, SUPABASE.ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return supabase;
}

export const auth = {
  /** Sign in with email + password. */
  async signIn(email, password) {
    const sb = getSupabase();
    if (!sb) throw new Error('Auth not configured.');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  /** Sign up with email + password + optional metadata. */
  async signUp(email, password, metadata = {}) {
    const sb = getSupabase();
    if (!sb) throw new Error('Auth not configured.');
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: metadata },
    });
    if (error) throw error;
    return data;
  },

  /** Verify an OTP token sent to email. */
  async verifyOtp(email, token) {
    const sb = getSupabase();
    if (!sb) throw new Error('Auth not configured.');
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
    return data;
  },

  /** Resend the OTP / confirmation email. */
  async resendOtp(email) {
    const sb = getSupabase();
    if (!sb) throw new Error('Auth not configured.');
    const { data, error } = await sb.auth.resend({ email, type: 'signup' });
    if (error) throw error;
    return data;
  },

  /** Send a password-reset email. */
  async resetPassword(email) {
    const sb = getSupabase();
    if (!sb) throw new Error('Auth not configured.');
    const { data, error } = await sb.auth.resetPasswordForEmail(email);
    if (error) throw error;
    return data;
  },

  /** Update the user's password (after reset). */
  async updatePassword(newPassword) {
    const sb = getSupabase();
    if (!sb) throw new Error('Auth not configured.');
    const { data, error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return data;
  },

  /** Sign out the current user. */
  async signOut() {
    const sb = getSupabase();
    if (!sb) return;
    await sb.auth.signOut();
  },

  /** Get the current session object (or null). */
  async getSession() {
    const sb = getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session;
  },

  /** Get the current user object (or null). */
  async getUser() {
    const sb = getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getUser();
    return data.user;
  },

  /** Get the access token string (or null). */
  async getAccessToken() {
    const session = await this.getSession();
    return session ? session.access_token : null;
  },

  /** Subscribe to auth state changes. Returns an unsubscribe function. */
  onAuthStateChange(callback) {
    const sb = getSupabase();
    if (!sb) return () => {};
    const { data } = sb.auth.onAuthStateChange((_event, session) => {
      callback(session);
    });
    return () => data.subscription.unsubscribe();
  },
};

export default auth;
