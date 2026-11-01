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
import { ServerConfigurationStore } from "../../../js/data/local/serverConfigurationStore.js";
import { button, clear, h, safeLinkUrl, spinner, toast } from "../lib/dom.js";
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

function renderDeviceCode(panel, isActive) {
  let pollTimer = 0;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    clearTimeout(pollTimer);
    QrLoginService.cleanup?.();
  };

  async function begin() {
    clear(panel).append(spinner("Preparing sign-in"));
    const [session, qrcode] = await Promise.all([QrLoginService.start(), loadQrLibrary().catch(() => null)]);
    if (cancelled || !isActive()) return;
    if (!session) {
      clear(panel).append(
        h("p", { class: "form-error" }, describeError(QrLoginService.getLastError())),
        button("Try again", begin, { kind: "primary" })
      );
      return;
    }

    const loginUrl = safeLinkUrl(session.loginUrl);
    const status = h("p", { class: "login-status", role: "status" }, "Waiting for approval…");
    clear(panel).append(
      qrcode ? h("div", { class: "login-qr-wrap" }, qrImage(qrcode, session.loginUrl)) : null,
      h("p", { class: "login-hint" }, "Scan with another device, or open the link on this one."),
      h("div", { class: "login-code", "aria-label": "Sign-in code" }, session.displayCode),
      loginUrl
        ? h(
            "a",
            { class: "btn btn-primary", href: loginUrl, target: "_blank", rel: "noopener noreferrer" },
            "Open sign-in page"
          )
        : null,
      status
    );

    const poll = async () => {
      if (cancelled || !isActive()) return;
      if (session.expiresAt && Date.now() > session.expiresAt) {
        begin();
        return;
      }
      const result = await QrLoginService.poll(session.code, session.deviceNonce);
      if (cancelled || !isActive()) return;
      const state = String(result?.status || "").toLowerCase();
      if (state === "approved") {
        status.textContent = "Approved. Signing in…";
        const exchanged = await QrLoginService.exchange(session.code, session.deviceNonce);
        if (!exchanged && !cancelled) {
          status.textContent = describeError(QrLoginService.getLastError());
          status.classList.add("form-error");
        }
        return;
      }
      if (state === "expired" || state === "used" || state === "cancelled") {
        begin();
        return;
      }
      pollTimer = setTimeout(poll, Math.max(2, result?.pollIntervalSeconds || session.pollIntervalSeconds) * 1000);
    };
    pollTimer = setTimeout(poll, session.pollIntervalSeconds * 1000);
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
