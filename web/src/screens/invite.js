// First screen on a deployment shared with friends. A newcomer asks for access with their name and
// waits. Behind the scenes the app also starts the Nuvio device sign-in and sends its link with the
// request, so the owner approves both from their own phone and the newcomer never sees a code.
// People who were given an invite code can still use it.
import { QrLoginService } from "../../../js/core/auth/qrLoginService.js";
import { LocalStore } from "../../../js/core/storage/localStore.js";
import { supportsTvLogin } from "../../../js/core/server/serverConfiguration.js";
import { ServerConfigurationStore } from "../../../js/data/local/serverConfigurationStore.js";
import { button, clear, h, spinner } from "../lib/dom.js";
import { Backend } from "../services/backend.js";

const PENDING_KEY = "webAccessRequest";
const CHECK_EVERY_MS = 3000;

function friendlyError(failure) {
  if (failure?.status === 401) return "That code isn't valid. Check it and try again.";
  if (failure?.status === 429) return failure.message || "Too many tries. Wait a few minutes and try again.";
  if (failure?.status === 400) return failure.message || "Something in the request wasn't accepted.";
  return "Nuvio can't be reached right now. Try again later.";
}

export function mountInvite(node, _route, { onAccepted } = {}) {
  const card = h("div", { class: "invite-card stack" });
  node.append(h("div", { class: "invite-backdrop" }, card));
  let stopped = false;
  let timer = 0;

  const header = (title, text) => [
    h("img", { class: "login-logo", src: "./assets/brand/app_logo_wordmark.png", alt: "Nuvio" }),
    h("h1", {}, title),
    text ? h("p", { class: "login-sub" }, text) : null
  ];

  function showRequestForm(message = "") {
    const name = h("input", { type: "text", placeholder: "Your name", "aria-label": "Your name", maxLength: 40, autocomplete: "given-name", required: true });
    const error = h("p", { class: "form-error", role: "alert", hidden: !message }, message);
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Request access");
    clear(card).append(
      h(
        "form",
        {
          class: "stack",
          onSubmit: async (event) => {
            event.preventDefault();
            submit.disabled = true;
            error.hidden = true;
            try {
              await sendRequest(name.value.trim());
            } catch (failure) {
              error.textContent = friendlyError(failure);
              error.hidden = false;
              submit.disabled = false;
            }
          }
        },
        ...header("Request access", "Nuvio here is private. Ask for access, and you'll get in as soon as you're approved."),
        name,
        error,
        submit
      ),
      button("I have an invite code", () => showCodeForm(), { kind: "ghost" })
    );
    name.focus();
  }

  function showCodeForm() {
    const input = h("input", {
      type: "text",
      placeholder: "xxxxxx-xxxxxx-xxxxxx-xxxxxx",
      "aria-label": "Invite code",
      autocapitalize: "off",
      autocomplete: "one-time-code",
      autocorrect: "off",
      spellcheck: false,
      required: true
    });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Continue");
    clear(card).append(
      h(
        "form",
        {
          class: "stack",
          onSubmit: async (event) => {
            event.preventDefault();
            submit.disabled = true;
            error.hidden = true;
            try {
              const result = await Backend.connect(Backend.getBaseUrl(), input.value.trim());
              onAccepted?.(result?.name);
            } catch (failure) {
              error.textContent = friendlyError(failure);
              error.hidden = false;
            } finally {
              submit.disabled = false;
            }
          }
        },
        ...header("Invite code", "Enter the code you were sent. You only need to do this once on this device."),
        input,
        error,
        submit
      ),
      button("Request access instead", () => showRequestForm(), { kind: "ghost" })
    );
    input.focus();
  }

  async function startNuvioSignIn() {
    if (!supportsTvLogin(ServerConfigurationStore.getActive())) return null;
    const session = await QrLoginService.start();
    if (!session) throw new Error(QrLoginService.getLastError() || "Nuvio sign-in couldn't start");
    return {
      code: session.code,
      deviceNonce: session.deviceNonce,
      displayCode: session.displayCode,
      loginUrl: session.loginUrl,
      expiresAt: session.expiresAt || 0
    };
  }

  async function sendRequest(name) {
    const nuvio = await startNuvioSignIn();
    const created = await Backend.requestAccess({ name, signInCode: nuvio?.displayCode || null, signInLink: nuvio?.loginUrl || null });
    const pending = { id: created.id, token: created.pollToken, name, nuvio, backendDone: false, nuvioDone: !nuvio };
    LocalStore.set(PENDING_KEY, pending);
    showWaiting(pending);
  }

  function showWaiting(pending) {
    const status = h("p", { class: "login-status", role: "status" }, "Waiting for approval…");
    clear(card).append(
      ...header("Request sent", `Thanks, ${pending.name}. You'll get in automatically once you're approved. You can leave this screen open, or come back later.`),
      h("div", { class: "center-pad" }, spinner("Waiting for approval")),
      status,
      button("Cancel request", () => {
        LocalStore.remove(PENDING_KEY);
        clearTimeout(timer);
        showRequestForm();
      }, { kind: "ghost" })
    );
    checkLoop(pending, status);
  }

  async function checkOnce(pending, status) {
    if (!pending.backendDone) {
      const result = await Backend.checkRequest(pending.id, pending.token);
      if (result.status === "declined") {
        LocalStore.remove(PENDING_KEY);
        showRequestForm("Your request wasn't approved.");
        return "stop";
      }
      if (result.status === "approved" && result.code) {
        await Backend.connect(Backend.getBaseUrl(), result.code, { remember: true });
        pending.backendDone = true;
        LocalStore.set(PENDING_KEY, pending);
      }
    }
    if (pending.backendDone && !pending.nuvioDone) status.textContent = "Approved. Waiting for the last step…";
    if (pending.nuvio && !pending.nuvioDone) {
      if (pending.nuvio.expiresAt && Date.now() > pending.nuvio.expiresAt) {
        // Nuvio's codes only last a few minutes, so a long wait sends the owner a fresh link.
        pending.nuvio = await startNuvioSignIn();
        LocalStore.set(PENDING_KEY, pending);
        await Backend.updateRequest(pending.id, pending.token, { signInCode: pending.nuvio.displayCode, signInLink: pending.nuvio.loginUrl });
      }
      const poll = await QrLoginService.poll(pending.nuvio.code, pending.nuvio.deviceNonce);
      if (String(poll?.status || "").toLowerCase() === "approved") {
        if (!(await QrLoginService.exchange(pending.nuvio.code, pending.nuvio.deviceNonce))) {
          throw new Error(QrLoginService.getLastError() || "Nuvio sign-in failed");
        }
        pending.nuvioDone = true;
        LocalStore.set(PENDING_KEY, pending);
      }
    }
    if (pending.backendDone && pending.nuvioDone) {
      // Takes the request off the owner's list. If this fails, it drops off by itself within a day.
      await Backend.updateRequest(pending.id, pending.token, { signedIn: true }).catch(() => null);
      LocalStore.remove(PENDING_KEY);
      onAccepted?.(pending.name);
      return "stop";
    }
    return "continue";
  }

  function checkLoop(pending, status) {
    const run = async () => {
      if (stopped) return;
      let next = "continue";
      try {
        next = await checkOnce(pending, status);
      } catch (failure) {
        if (failure?.status === 404) {
          LocalStore.remove(PENDING_KEY);
          showRequestForm("Your request expired. Ask again.");
          return;
        }
        status.textContent = "Still waiting. Reconnecting…";
      }
      if (next === "continue" && !stopped) timer = setTimeout(run, CHECK_EVERY_MS);
    };
    clearTimeout(timer);
    run();
  }

  const onReturn = () => {
    const pending = LocalStore.get(PENDING_KEY, null);
    const status = card.querySelector(".login-status");
    if (document.visibilityState === "visible" && pending && status) checkLoop(pending, status);
  };
  document.addEventListener("visibilitychange", onReturn);

  const pending = LocalStore.get(PENDING_KEY, null);
  if (pending?.id) showWaiting(pending);
  else showRequestForm();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onReturn);
  };
}
