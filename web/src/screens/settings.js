import { AuthManager } from "../../../js/core/auth/authManager.js";
import { StartupSyncService } from "../../../js/core/profile/startupSyncService.js";
import { ProfileManager } from "../../../js/core/profile/profileManager.js";
import { PlayerSettingsStore } from "../../../js/data/local/playerSettingsStore.js";
import { ServerConfigurationStore } from "../../../js/data/local/serverConfigurationStore.js";
import { ThemeStore, accentColorForTheme } from "../../../js/data/local/themeStore.js";
import { addonRepository } from "../../../js/data/repository/addonRepository.js";
import { ThemeManager } from "../../../js/ui/theme/themeManager.js";
import { availableThemeIds } from "../../../js/ui/theme/themeAccess.js";
import { MemberAccessRepository } from "../../../js/data/remote/supabase/memberAccessRepository.js";
import { button, clear, h, icon, iconButton, image, spinner, toast } from "../lib/dom.js";
import { goBack, hrefFor, navigate } from "../lib/router.js";
import { Backend } from "../services/backend.js";
import { showLogin, switchProfile } from "../main.js";

const SECTIONS = [
  { id: "account", label: "Account", iconName: "person" },
  { id: "addons", label: "Addons", iconName: "extension" },
  { id: "streaming", label: "Streaming backend", iconName: "dns" },
  { id: "playback", label: "Playback", iconName: "play_circle" },
  { id: "appearance", label: "Appearance", iconName: "palette" },
  { id: "about", label: "About", iconName: "info" }
];
const SUBTITLE_LANGUAGES = [
  ["off", "Off"], ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["no", "Norwegian"], ["sv", "Swedish"],
  ["da", "Danish"], ["pl", "Polish"], ["ar", "Arabic"], ["hi", "Hindi"], ["ja", "Japanese"]
];

function settingsRow(label, detail, control) {
  return h(
    "div",
    { class: "setting-row" },
    h("div", { class: "setting-text" }, h("strong", {}, label), detail ? h("span", {}, detail) : null),
    control
  );
}

function renderAccount(container) {
  const signedIn = AuthManager.isAuthenticated;
  const server = ServerConfigurationStore.getActive();
  container.append(
    settingsRow(
      signedIn ? "Signed in" : "Not signed in",
      signedIn
        ? `Addons, profiles, library and progress sync with ${server.isCustom ? server.backendUrl : "your Nuvio account"}.`
        : "You're using Nuvio without an account. Data stays in this browser.",
      signedIn
        ? button("Sign out", async () => {
            await AuthManager.signOut();
            showLogin();
          })
        : button("Sign in", () => showLogin(), { kind: "primary" })
    ),
    settingsRow("Profile", `Active profile ${ProfileManager.getActiveProfileId() || 1}`, button("Switch", () => switchProfile())),
    signedIn
      ? settingsRow(
          "Sync now",
          "Pull the latest data from your account.",
          button("Sync", async (event) => {
            event.currentTarget.disabled = true;
            await StartupSyncService.requestSyncNow({ force: true, notifyPullCompleted: true }).catch((error) => {
              toast(error?.message || "Sync failed", { error: true });
            });
            toast("Sync finished");
            container.querySelector("button[disabled]")?.removeAttribute("disabled");
          })
        )
      : null
  );
}

async function renderAddons(container) {
  const form = h(
    "form",
    {
      class: "addon-add",
      onSubmit: async (event) => {
        event.preventDefault();
        const url = input.value.trim().replace(/^stremio:\/\//i, "https://");
        if (!url) return;
        submit.disabled = true;
        try {
          await addonRepository.addAddon(url);
          input.value = "";
          toast("Addon added");
          await draw();
        } catch (error) {
          toast(`Couldn't add this addon: ${error?.message || "invalid manifest"}`, { error: true });
        } finally {
          submit.disabled = false;
        }
      }
    }
  );
  const input = h("input", { type: "url", placeholder: "Addon URL (…/manifest.json)", "aria-label": "Addon URL", inputMode: "url", autocapitalize: "off", required: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Add");
  form.append(input, submit);
  const list = h("div", { class: "addon-list" }, spinner());
  container.append(form, list);

  async function draw() {
    const addons = await addonRepository.getInstalledAddons({ includeDisabled: true });
    const urls = addonRepository.getInstalledAddonUrls();
    const canEdit = addonRepository.canEdit();
    const canonical = (url) => addonRepository.normalizeUrl(url);
    const failed = urls.filter((url) => !addons.some((addon) => canonical(addon.baseUrl) === canonical(url)));

    const move = async (url, delta) => {
      const order = addonRepository.getInstalledAddonUrls();
      const index = order.indexOf(url);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      await addonRepository.setAddonOrder(order);
      draw();
    };

    clear(list).append(
      !canEdit ? h("p", { class: "notice" }, "This profile uses the primary profile's addons, so they can only be changed there.") : "",
      ...addons.map((addon) => {
        const enabled = addonRepository.isAddonEnabled(addon.baseUrl);
        return h(
          "div",
          { class: `addon-row ${enabled ? "" : "is-disabled"}` },
          h("span", { class: "addon-logo" }, addon.logo ? image(addon.logo, { alt: "" }) : icon("extension")),
          h(
            "div",
            { class: "addon-text" },
            h("strong", {}, addon.displayName),
            h("span", {}, `v${addon.version} · ${(addon.resources || []).map((resource) => resource.name).join(", ") || "no resources"}`),
            addon.description ? h("small", {}, addon.description) : null
          ),
          canEdit
            ? h(
                "div",
                { class: "addon-actions" },
                iconButton("arrow_upward", `Move ${addon.displayName} up`, () => move(addon.baseUrl, -1)),
                iconButton("arrow_downward", `Move ${addon.displayName} down`, () => move(addon.baseUrl, 1)),
                iconButton("refresh", `Update ${addon.displayName}`, async () => {
                  await addonRepository.refreshAddon(addon.baseUrl);
                  toast("Addon updated");
                  draw();
                }),
                h("label", { class: "switch", title: enabled ? "Disable" : "Enable" },
                  h("input", {
                    type: "checkbox",
                    checked: enabled,
                    "aria-label": `Enable ${addon.displayName}`,
                    onChange: async (event) => {
                      await addonRepository.setAddonEnabledStates([{ url: addon.baseUrl, enabled: event.target.checked }]);
                      draw();
                    }
                  }),
                  h("span", { class: "switch-track" })
                ),
                iconButton("delete", `Remove ${addon.displayName}`, async () => {
                  if (!window.confirm(`Remove ${addon.displayName}?`)) return;
                  await addonRepository.removeAddon(addon.baseUrl);
                  draw();
                })
              )
            : null
        );
      }),
      ...failed.map((url) =>
        h(
          "div",
          { class: "addon-row is-disabled" },
          h("span", { class: "addon-logo" }, icon("cloud_off")),
          h("div", { class: "addon-text" }, h("strong", {}, "Unavailable addon"), h("span", {}, "The manifest couldn't load. It stays on your account.")),
          canEdit
            ? iconButton("delete", "Remove unavailable addon", async () => {
                await addonRepository.removeAddon(url);
                draw();
              })
            : null
        )
      )
    );
  }
  const redraw = () => {
    if (list.isConnected) draw().catch(() => null);
  };
  const unsubscribers = [addonRepository.onInstalledAddonsChanged?.(redraw), addonRepository.onManifestCacheChanged?.(redraw)];
  await draw();
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe?.());
}

function renderStreaming(container) {
  const url = h("input", { type: "url", placeholder: "https://your-backend.example", "aria-label": "Backend URL", value: Backend.getBaseUrl(), inputMode: "url", autocapitalize: "off", required: true });
  const key = h("input", { type: "password", placeholder: "Access key", "aria-label": "Access key", autocomplete: "off", required: true });
  const status = h("p", { class: "setting-status", role: "status" });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Connect");

  async function refreshStatus() {
    if (!Backend.isConnected()) {
      status.textContent = Backend.isConfigured() ? "Not connected. Enter the access key to connect." : "No backend configured.";
      status.className = "setting-status";
      return;
    }
    try {
      const capabilities = await Backend.capabilities();
      status.textContent = `Connected. Torrents ${capabilities.torrents ? "on" : "off"}, remuxing ${capabilities.remux ? "on" : "off"}, transcoding ${capabilities.transcode ? "on" : "off"}.`;
      status.className = "setting-status is-ok";
    } catch (error) {
      status.textContent = error?.message || "The backend isn't responding.";
      status.className = "setting-status is-error";
    }
  }

  container.append(
    h(
      "p",
      { class: "muted" },
      "Browsers can't join torrent swarms or play most MKV files. Your own backend does that work and streams a playable video to this device. It holds no account data."
    ),
    h(
      "form",
      {
        class: "stack",
        onSubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          try {
            await Backend.connect(url.value, key.value);
            key.value = "";
            toast("Backend connected");
          } catch (error) {
            toast(error?.message || "Couldn't connect", { error: true });
          } finally {
            submit.disabled = false;
            refreshStatus();
          }
        }
      },
      url,
      key,
      submit
    ),
    status,
    button("Disconnect", () => {
      Backend.disconnect();
      url.value = Backend.getBaseUrl();
      refreshStatus();
    }, { kind: "ghost" })
  );
  refreshStatus();
}

function renderPlayback(container) {
  const settings = PlayerSettingsStore.get();
  const current = settings?.subtitleStyle?.preferredLanguage || "off";
  const select = h(
    "select",
    {
      "aria-label": "Preferred subtitle language",
      onChange: (event) => {
        PlayerSettingsStore.set({
          subtitleStyle: { ...PlayerSettingsStore.get().subtitleStyle, preferredLanguage: event.target.value }
        });
        toast("Saved");
      }
    },
    SUBTITLE_LANGUAGES.map(([value, label]) => h("option", { value, selected: value === current }, label))
  );
  container.append(settingsRow("Subtitles", "Turned on automatically when a matching track exists.", select));
}

function renderAppearance(container) {
  const themes = availableThemeIds(MemberAccessRepository.getCachedAccess()).filter((id) => id !== "CUSTOM");
  const active = String(ThemeStore.get()?.themeName || "WHITE").toUpperCase();
  container.append(
    h("h3", { class: "setting-subhead" }, "Accent"),
    h(
      "div",
      { class: "swatches" },
      themes.map((theme) =>
        h("button", {
          type: "button",
          class: `swatch ${theme === active ? "is-active" : ""}`,
          style: { background: accentColorForTheme(theme) },
          "aria-label": theme.replace("_", " ").toLowerCase(),
          title: theme.replace("_", " ").toLowerCase(),
          onClick: () => {
            ThemeStore.set({ themeName: theme, accentColor: accentColorForTheme(theme) });
            ThemeManager.apply();
            clear(container);
            renderAppearance(container);
          }
        })
      )
    )
  );
}

function renderAbout(container) {
  container.append(
    settingsRow("Nuvio Web", `Version ${typeof __NUVIO_APP_VERSION__ === "undefined" ? "dev" : __NUVIO_APP_VERSION__}`, null),
    h(
      "p",
      { class: "muted" },
      "Based on NuvioTVSmart by Nuvio Media. Free software under the GNU General Public License v3.0. You can get the source code, change it and share it under the same license."
    ),
    h(
      "div",
      { class: "link-row" },
      h("a", { href: "https://github.com/NuvioMedia/NuvioTVSmart", target: "_blank", rel: "noopener noreferrer" }, "Original source"),
      h("a", { href: "./LICENSE.txt", target: "_blank", rel: "noopener" }, "License")
    )
  );
}

const RENDERERS = {
  account: renderAccount,
  addons: renderAddons,
  streaming: renderStreaming,
  playback: renderPlayback,
  appearance: renderAppearance,
  about: renderAbout
};

export function mountSettings(node, route) {
  const sectionId = route.segments[0] || "";
  const section = SECTIONS.find((entry) => entry.id === sectionId);
  const menu = h(
    "nav",
    { class: "settings-menu", "aria-label": "Settings" },
    SECTIONS.map((entry) =>
      h(
        "a",
        { class: `settings-link ${entry.id === sectionId ? "is-active" : ""}`, href: hrefFor("settings", [entry.id]) },
        icon(entry.iconName),
        h("span", {}, entry.label),
        icon("chevron_right", { className: "settings-chevron" })
      )
    )
  );
  const panel = h("div", { class: "settings-panel" });
  node.classList.toggle("has-section", Boolean(section));
  node.append(
    h(
      "header",
      { class: `page-head ${section ? "page-head-back" : ""}` },
      section ? iconButton("arrow_back", "Back", () => goBack("settings"), { className: "settings-back" }) : null,
      h("h1", {}, section ? section.label : "Settings")
    ),
    h("div", { class: "settings-layout" }, menu, panel)
  );
  let disposeSection = null;
  let unmounted = false;
  if (section) {
    Promise.resolve(RENDERERS[section.id](panel))
      .then((dispose) => {
        if (unmounted) dispose?.();
        else disposeSection = dispose;
      })
      .catch((error) => {
        panel.append(h("p", { class: "form-error" }, error?.message || "This section couldn't load."));
      });
  } else if (window.matchMedia("(min-width: 900px)").matches) {
    navigate("settings", ["account"], null, { replace: true });
  }
  return () => {
    unmounted = true;
    disposeSection?.();
  };
}
