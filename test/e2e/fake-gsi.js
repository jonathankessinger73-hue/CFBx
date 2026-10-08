// Stand-in for Google Identity Services (accounts.google.com/gsi/client):
// renderButton draws a button that hands the page a fake ID token.
window.google = {
  accounts: {
    id: {
      initialize(config) {
        window.__gsiConfig = config;
      },
      renderButton(el) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Sign in with Google";
        b.addEventListener("click", () => window.__gsiConfig.callback({ credential: "fake-google-id-token" }));
        el.appendChild(b);
      },
    },
  },
};
