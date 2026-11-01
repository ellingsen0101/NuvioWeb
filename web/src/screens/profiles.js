import { AuthManager } from "../../../js/core/auth/authManager.js";
import { MAX_PROFILES, ProfileManager } from "../../../js/core/profile/profileManager.js";
import { ProfileSyncService } from "../../../js/core/profile/profileSyncService.js";
import { button, h, icon, image, openSheet, toast } from "../lib/dom.js";
import { enterApp } from "../main.js";

const AVATAR_COLORS = ["#1E88E5", "#E53935", "#8E24AA", "#00897B", "#F4511E", "#FDD835"];

function avatar(profile) {
  const initial = String(profile.name || "?").trim().charAt(0).toUpperCase();
  return h(
    "span",
    { class: "profile-avatar", style: { background: profile.avatarColorHex || "#1E88E5" } },
    // The initial stays underneath, so a slow or failed avatar image still identifies the profile.
    initial,
    profile.avatarUrl ? image(profile.avatarUrl, { alt: "" }) : null
  );
}

function askPin(profile) {
  return new Promise((resolve) => {
    const input = h("input", {
      type: "password",
      inputMode: "numeric",
      autocomplete: "off",
      maxLength: 8,
      placeholder: "PIN",
      "aria-label": `PIN for ${profile.name}`
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      sheet.close();
      resolve(value);
    };
    const sheet = openSheet({
      title: `Enter PIN for ${profile.name}`,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
      content: h(
        "form",
        {
          class: "stack",
          onSubmit: (event) => {
            event.preventDefault();
            finish(input.value);
          }
        },
        input,
        h("button", { type: "submit", class: "btn btn-primary" }, "Continue")
      )
    });
    input.focus();
  });
}

function editProfile(profile, onSaved) {
  const name = h("input", { value: profile?.name || "", maxLength: 24, placeholder: "Profile name", "aria-label": "Profile name", required: true });
  let color = profile?.avatarColorHex || AVATAR_COLORS[0];
  const swatches = h(
    "div",
    { class: "swatches" },
    AVATAR_COLORS.map((value) =>
      h("button", {
        type: "button",
        class: `swatch ${value === color ? "is-active" : ""}`,
        style: { background: value },
        "aria-label": `Color ${value}`,
        onClick: (event) => {
          color = value;
          swatches.querySelectorAll(".swatch").forEach((node) => node.classList.remove("is-active"));
          event.currentTarget.classList.add("is-active");
        }
      })
    )
  );
  const sheet = openSheet({
    title: profile ? "Edit profile" : "Add profile",
    content: h(
      "form",
      {
        class: "stack",
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            if (profile) {
              await ProfileManager.updateProfile({ ...profile, name: name.value.trim(), avatarColorHex: color });
            } else {
              await ProfileManager.createProfile({ name: name.value.trim(), avatarColorHex: color });
            }
            if (AuthManager.isAuthenticated) await ProfileSyncService.push().catch(() => false);
            sheet.close();
            onSaved();
          } catch (error) {
            toast(error?.message || "The profile couldn't be saved", { error: true });
          }
        }
      },
      name,
      swatches,
      h("button", { type: "submit", class: "btn btn-primary" }, "Save"),
      profile && !profile.isPrimary
        ? button(
            "Delete profile",
            async () => {
              if (!window.confirm(`Delete ${profile.name}? Its local data on this device is removed too.`)) return;
              try {
                await ProfileManager.deleteProfile(profile.id);
                if (AuthManager.isAuthenticated) await ProfileSyncService.push().catch(() => false);
                sheet.close();
                onSaved();
              } catch (error) {
                toast(error?.message || "The profile couldn't be deleted", { error: true });
              }
            },
            { kind: "danger" }
          )
        : null
    )
  });
}

export function mountProfiles(node) {
  let managing = false;
  const grid = h("div", { class: "profile-grid" });
  const manage = button("Manage profiles", () => {
    managing = !managing;
    manage.querySelector("span").textContent = managing ? "Done" : "Manage profiles";
    render();
  }, { kind: "ghost" });

  async function choose(profile, pinStates) {
    if (managing) {
      editProfile(profile, render);
      return;
    }
    if (pinStates?.[profile.id] || pinStates?.[profile.profileIndex]) {
      const pin = await askPin(profile);
      if (pin == null) return;
      const result = await ProfileSyncService.verifyProfilePin(profile.id, pin).catch(() => null);
      if (!(result === true || result?.unlocked === true || result?.valid === true)) {
        toast("Incorrect PIN", { error: true });
        return;
      }
    }
    await enterApp(profile.id);
  }

  async function render() {
    const [profiles, pinStates] = await Promise.all([
      ProfileManager.getProfiles(),
      AuthManager.isAuthenticated ? ProfileSyncService.pullProfileLockStates().catch(() => ({})) : {}
    ]);
    grid.replaceChildren(
      ...profiles.map((profile) =>
        h(
          "button",
          { type: "button", class: "profile-tile", onClick: () => choose(profile, pinStates) },
          avatar(profile),
          h("span", { class: "profile-name" }, profile.name),
          pinStates?.[profile.id] ? icon("lock", { className: "profile-lock" }) : null,
          managing ? icon("edit", { className: "profile-edit" }) : null
        )
      ),
      profiles.length < MAX_PROFILES
        ? h(
            "button",
            { type: "button", class: "profile-tile", onClick: () => editProfile(null, render) },
            h("span", { class: "profile-avatar profile-add" }, icon("add")),
            h("span", { class: "profile-name" }, "Add Profile")
          )
        : ""
    );
  }

  node.append(
    h(
      "div",
      { class: "profiles" },
      h("img", { class: "login-logo", src: "./assets/brand/app_logo_wordmark.png", alt: "Nuvio" }),
      h("h1", {}, "Who's watching?"),
      grid,
      manage
    )
  );
  render();
}
