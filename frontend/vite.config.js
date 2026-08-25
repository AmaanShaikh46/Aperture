import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        login: 'login.html',
        register: 'register.html',
        verify: 'verify.html',
        forgotPassword: 'forgot-password.html',
        resetPassword: 'reset-password.html',
        app: 'app.html',
        profile: 'profile.html',
        contacts: 'contacts.html',
        calls: 'calls.html',
        assist: 'assist.html',
        admin: 'admin.html',
      },
    },
  },
});
