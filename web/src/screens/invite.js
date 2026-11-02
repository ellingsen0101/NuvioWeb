// First screen on an invite-only deployment. The code is exchanged with the backend for a session
// and isn't stored. After that the app continues to the usual Nuvio sign-in.
import { h } from "../lib/dom.js";
import { Backend } from "../services/backend.js";

export function mountInvite(node, _route, { onAccepted } = {}) {
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

  node.append(
    h(
      "div",
      { class: "invite-backdrop" },
      h(
        "form",
        {
          class: "invite-card stack",
          onSubmit: async (event) => {
            event.preventDefault();
            submit.disabled = true;
            error.hidden = true;
            try {
              const result = await Backend.connect(Backend.getBaseUrl(), input.value.trim());
              onAccepted?.(result?.name);
            } catch (failure) {
              error.textContent =
                failure?.status === 401
                  ? "That code isn't valid. Check it and try again."
                  : failure?.status === 429
                    ? "Too many tries. Wait a minute and try again."
                    : "Nuvio can't be reached right now. Try again later.";
              error.hidden = false;
            } finally {
              submit.disabled = false;
            }
          }
        },
        h("img", { class: "login-logo", src: "./assets/brand/app_logo_wordmark.png", alt: "Nuvio" }),
        h("h1", {}, "Invite only"),
        h("p", { class: "login-sub" }, "Enter the invite code you were sent. You only need to do this once on this device."),
        input,
        error,
        submit
      )
    )
  );
  input.focus();
}
