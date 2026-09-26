// Stand-in for the Supabase Auth browser bundle. signInWithOtp signs in
// immediately with a token the e2e server's fake verifier accepts, except for
// addresses containing "+code": those wait for verifyOtp with code 123456.
// signInWithOAuth records the provider instead of leaving the page.
window.supabase = {
  createClient() {
    const KEY = "fake-supabase-session";
    const listeners = [];
    const get = () => {
      try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
    };
    const emit = (event, session) => setTimeout(() => listeners.forEach((cb) => cb(event, session)), 0);
    const signIn = (email) => {
      const id = crypto.randomUUID();
      const session = { access_token: "test-" + id, user: { id, email } };
      localStorage.setItem(KEY, JSON.stringify(session));
      emit("SIGNED_IN", session);
      return { data: {}, error: null };
    };
    return {
      auth: {
        getSession: async () => ({ data: { session: get() }, error: null }),
        onAuthStateChange(cb) {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe() {} } } };
        },
        async signInWithOtp({ email }) {
          if (email.includes("+code")) return { data: {}, error: null };
          return signIn(email);
        },
        async verifyOtp({ token, email }) {
          if (token !== "123456") return { data: {}, error: { message: "Token has expired or is invalid" } };
          return signIn(email);
        },
        async signInWithOAuth({ provider }) {
          window.__oauthProvider = provider;
          return { data: {}, error: null };
        },
        async signOut() {
          localStorage.removeItem(KEY);
          emit("SIGNED_OUT", null);
          return { error: null };
        },
      },
    };
  },
};
