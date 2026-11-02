// Sign-in uses the same device-code flow as the TV app (QrLoginService): the browser shows a code,
// and the user approves it on the account page. Email and password appear only for servers that
// advertise it. The official server's configuration sets emailPasswordAuth to false.
import { AuthManager } from "../../../js/core/auth/authManager.js";
import { QrLoginService } from "../../../js/core/auth/qrLoginService.js";
import { discoverServer } from "../../../js/core/server/serverDiscovery.js";
import {
  supportsEmailPasswordAuth,
  supportsTvLogin
} from "../../../js/core/server/serverConfiguration.js";
import { LocalStore } from "../../../js/core/storage/localStore.js";
import { ServerConfigurationStore } from "../../../js/data/local/serverConfigurationStore.js";
import { button, clear, fill, h, safeLinkUrl, spinner, toast } from "../lib/dom.js";
import { continueAsGuest } from "../main.js";

// The generator is a classic script, the same one the TV app loads, needed only on this screen.
let qrLibrary = null;
function loadQrLibrary() {
  qrLibrary ||= new Promise((resolve, reject) => {
    const script = h("script", { src: "./assets/libs/qrcode-generator.js", onLoad: () => resolve(globalThis.qrcode), onError: reject });
    document.head.append(script);
  });
  return qrLibrary;
}

function qrImage(qrcode, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return h("img", { class: "login-qr", alt: "QR code for sign-in", src: qr.createDataURL(6, 2) });
}

function describeError(message) {
  const text = String(message || "");
  if (/failed to fetch|load failed|networkerror/i.test(text)) {
    return "The account server couldn't be reached from this browser. Check your connection, or the server may not allow requests from this site.";
  }
  return text || "Something went wrong.";
}

// Keeps the code across an app reload, so that approving it on the website still signs this app in.
// It's short-lived and useless without the anonymous session already stored by upstream's SessionStore.
const PENDING_LOGIN_KEY = "webPendingDeviceLogin";

function readPendingLogin() {
  const pending = LocalStore.get(PENDING_LOGIN_KEY, null);
  if (!pending?.code || !pending.deviceNonce || !(pending.expiresAt > Date.now())) {
    LocalStore.remove(PENDING_LOGIN_KEY);
    return null;
  }
  return pending;
}

function savePendingLogin(session) {
  if (session.expiresAt) LocalStore.set(PENDING_LOGIN_KEY, session);
}

function clearPendingLogin() {
  LocalStore.remove(PENDING_LOGIN_KEY);
}

function renderDeviceCode(panel, isActive) {
  let pollTimer = 0;
  let cancelled = false;
  let pollNow = null;
  // iPhones pause a Home Screen app, and may reload it, while you approve the code on the website.
  const onReturn = () => {
    if (document.visibilityState === "visible") pollNow?.();
  };
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("pageshow", onReturn);
  const stop = () => {
    cancelled = true;
    clearTimeout(pollTimer);
    document.removeEventListener("visibilitychange", onReturn);
    window.removeEventListener("pageshow", onReturn);
    QrLoginService.cleanup?.();
  };

  async function begin({ fresh = false } = {}) {
    pollNow = null;
    clearTimeout(pollTimer);
    clear(panel).append(spinner("Preparing sign-in"));
    const saved = fresh ? null : readPendingLogin();
    const [session, qrcode] = await Promise.all([saved || QrLoginService.start(), loadQrLibrary().catch(() => null)]);
    if (cancelled || !isActive()) return;
    if (!session) {
      clear(panel).append(
        h("p", { class: "form-error" }, describeError(QrLoginService.getLastError())),
        button("Try again", () => begin({ fresh: true }), { kind: "primary" })
      );
      return;
    }
    savePendingLogin(session);

    const loginUrl = safeLinkUrl(session.loginUrl);
    const status = h("p", { class: "login-status", role: "status" }, "Waiting for approval…");
    // Approving happens on Nuvio's own website, which then shows its account page rather than sending
    // people back here. The steps say so, because that page looks like a destination.
    fill(panel,
      h("div", { class: "login-code", "aria-label": "Sign-in code" }, session.displayCode),
      h(
        "ol",
        { class: "login-steps" },
        h("li", {}, "Tap ", h("strong", {}, "Approve on Nuvio"), " and sign in to your Nuvio account."),
        h("li", {}, "Approve the code above."),
        h("li", {}, "Nuvio's site then shows your account page. ", h("strong", {}, "Come back to this app"), ". It continues by itself.")
      ),
      loginUrl
        ? h(
            "a",
            { class: "btn btn-primary", href: loginUrl, target: "_blank", rel: "noopener noreferrer" },
            "Approve on Nuvio"
          )
        : null,
      status,
      qrcode
        ? h(
            "details",
            { class: "login-qr-details" },
            h("summary", {}, "Use another device instead"),
            h("div", { class: "login-qr-wrap" }, qrImage(qrcode, session.loginUrl)),
            h("p", { class: "login-hint" }, "Scan this with a phone or tablet that's signed in to Nuvio.")
          )
        : null
    );

    let polling = false;
    let finished = false;
    const poll = async () => {
      if (cancelled || !isActive() || polling || finished) return;
      polling = true;
      clearTimeout(pollTimer);
      try {
        if (session.expiresAt && Date.now() > session.expiresAt) {
          finished = true;
          begin({ fresh: true });
          return;
        }
        const result = await QrLoginService.poll(session.code, session.deviceNonce);
        if (cancelled || !isActive()) return;
        const state = String(result?.status || "").toLowerCase();
        if (state === "approved") {
          finished = true;
          status.textContent = "Approved. Signing in…";
          const exchanged = await QrLoginService.exchange(session.code, session.deviceNonce);
          clearPendingLogin();
          if (!exchanged && !cancelled) {
            status.textContent = describeError(QrLoginService.getLastError());
            status.classList.add("form-error");
          }
          return;
        }
        if (state === "expired" || state === "used" || state === "cancelled") {
          finished = true;
          begin({ fresh: true });
          return;
        }
        pollTimer = setTimeout(poll, Math.max(2, result?.pollIntervalSeconds || session.pollIntervalSeconds) * 1000);
      } finally {
        polling = false;
      }
    };
    pollNow = poll;
    pollTimer = setTimeout(poll, saved ? 0 : session.pollIntervalSeconds * 1000);
  }

  begin();
  return stop;
}

function renderEmailForm(panel) {
  const email = h("input", { type: "email", required: true, autocomplete: "username", placeholder: "Email", "aria-label": "Email" });
  const password = h("input", { type: "password", required: true, autocomplete: "current-password", placeholder: "Password", "aria-label": "Password" });
  const error = h("p", { class: "form-error", hidden: true, role: "alert" });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Sign in");
  clear(panel).append(
    h(
      "form",
      {
        class: "stack",
        onSubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          error.hidden = true;
          try {
            await AuthManager.signInWithEmail(email.value.trim(), password.value);
          } catch (signInError) {
            error.textContent = describeError(signInError?.message);
            error.hidden = false;
          } finally {
            submit.disabled = false;
          }
        }
      },
      email,
      password,
      error,
      submit
    )
  );
}

function renderServerForm(container, onChanged) {
  const active = ServerConfigurationStore.getActive();
  const input = h("input", { type: "url", placeholder: "https://your-server.example", "aria-label": "Server address", inputMode: "url", autocapitalize: "off" });
  const submit = h("button", { type: "submit", class: "btn btn-secondary" }, "Connect");
  const form = h(
    "form",
    {
      class: "stack",
      onSubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const discovered = await discoverServer(input.value.trim());
          if (!ServerConfigurationStore.saveCustom({ ...discovered, isCustom: true })) {
            throw new Error("The server configuration could not be saved");
          }
          toast("Server connected");
          onChanged();
        } catch (error) {
          toast(`Couldn't connect: ${error?.code || error?.message || "unknown error"}`, { error: true });
        } finally {
          submit.disabled = false;
        }
      }
    },
    input,
    submit
  );
  clear(container).append(
    active.isCustom
      ? h(
          "div",
          { class: "stack" },
          h("p", { class: "login-hint" }, `Connected to ${active.backendUrl}`),
          button("Use the official server", () => {
            ServerConfigurationStore.useOfficial();
            onChanged();
          })
        )
      : form
  );
}

export function mountLogin(node) {
  let active = true;
  let stopFlow = () => {};
  const panel = h("div", { class: "login-panel" });
  const serverBox = h("div", {});

  function renderFlow() {
    stopFlow();
    stopFlow = () => {};
    const configuration = ServerConfigurationStore.getActive();
    if (supportsTvLogin(configuration)) {
      stopFlow = renderDeviceCode(panel, () => active);
    } else if (supportsEmailPasswordAuth(configuration)) {
      renderEmailForm(panel);
    } else {
      clear(panel).append(
        h(
          "p",
          { class: "login-hint" },
          "This Nuvio Web build isn't connected to an account server yet. Connect a self-hosted server below, or continue without an account."
        )
      );
    }
    renderServerForm(serverBox, renderFlow);
  }

  node.append(
    h(
      "div",
      { class: "login" },
      h("img", { class: "login-logo", src: "./assets/brand/app_logo_wordmark.png", alt: "Nuvio" }),
      h("h1", {}, "Sign in to Nuvio"),
      h("p", { class: "login-sub" }, "Your addons, profiles, library and progress follow your account."),
      panel,
      button("Continue without an account", () => continueAsGuest(), { kind: "ghost" }),
      h("details", { class: "login-server" }, h("summary", {}, "Use a self-hosted server"), serverBox)
    )
  );
  renderFlow();

  return () => {
    active = false;
    stopFlow();
  };
}
