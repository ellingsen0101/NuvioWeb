// Owner-only Settings section: approve or decline access requests, and remove people.
import { button, clear, emptyState, h, spinner, toast } from "../lib/dom.js";
import { Backend } from "../services/backend.js";
import { refreshRequestBadge } from "../services/requestWatch.js";

function ago(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : "yesterday";
}

export async function renderPeople(container) {
  const requestsBox = h("div", { class: "stack" }, spinner());
  const peopleBox = h("div", { class: "stack" });
  container.append(
    h("h3", { class: "setting-subhead" }, "Waiting for approval"),
    h(
      "p",
      { class: "muted" },
      "Approving someone takes two taps: Approve here, then Approve on Nuvio, which opens Nuvio's page with their code filled in. Tap Approve there too, so their device can use your Nuvio account."
    ),
    requestsBox,
    h("h3", { class: "setting-subhead" }, "People with access"),
    peopleBox
  );

  async function draw() {
    let requests;
    let people;
    try {
      [{ requests }, { people }] = await Promise.all([Backend.pendingRequests(), Backend.people()]);
    } catch (error) {
      clear(requestsBox).append(h("p", { class: "form-error" }, error?.status === 403 ? "Only the owner can manage people." : error?.message || "This couldn't load."));
      clear(peopleBox);
      return;
    }
    refreshRequestBadge(requests.length);

    clear(requestsBox).append(
      ...(requests.length
        ? requests.map((request) =>
            request.status === "approved"
              ? h(
                  "div",
                  { class: "addon-row" },
                  h("div", { class: "addon-text" }, h("strong", {}, request.name), h("span", {}, "Approved. One more step: approve them on Nuvio.")),
                  h(
                    "div",
                    { class: "addon-actions" },
                    // A real link, because phones block pages a script opens. It stays here until their
                    // device is signed in, and always carries their latest code.
                    h("a", { class: "btn btn-primary", href: request.signInLink, target: "_blank", rel: "noopener" }, "Approve on Nuvio")
                  )
                )
              : h(
                  "div",
                  { class: "addon-row" },
                  h("div", { class: "addon-text" }, h("strong", {}, request.name), h("span", {}, `Asked ${ago(request.createdAt)}`)),
                  h(
                    "div",
                    { class: "addon-actions" },
                    button("Decline", async () => {
                      await Backend.answerRequest(request.id, false).catch((error) => toast(error.message, { error: true }));
                      draw();
                    }, { kind: "ghost" }),
                    button("Approve", async () => {
                      await Backend.answerRequest(request.id, true).catch((error) => toast(error.message, { error: true }));
                      draw();
                    }, { kind: "primary" })
                  )
                )
          )
        : [emptyState({ iconName: "how_to_reg", title: "No one is waiting", detail: "When someone taps Request access, they appear here." })])
    );

    clear(peopleBox).append(
      ...people.map((person) =>
        h(
          "div",
          { class: "addon-row" },
          h("div", { class: "addon-text" }, h("strong", {}, person.name), h("span", {}, person.admin ? "Owner" : `Since ${String(person.createdAt || "").slice(0, 10)}`)),
          person.admin
            ? null
            : button("Remove", async () => {
                if (!window.confirm(`Remove ${person.name}? They lose access straight away. To also sign their device out of your Nuvio account, remove it in Nuvio's account settings.`)) return;
                await Backend.removePerson(person.name).catch((error) => toast(error.message, { error: true }));
                draw();
              }, { kind: "danger" })
        )
      )
    );
  }

  await draw();
  const timer = setInterval(() => {
    if (container.isConnected && document.visibilityState === "visible") draw().catch(() => null);
  }, 15000);
  return () => clearInterval(timer);
}
