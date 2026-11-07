import { AuthManager } from "../../js/core/auth/authManager.js";
import { AuthState } from "../../js/core/auth/authState.js";
import { DeviceSessionRegistration } from "../../js/core/auth/deviceSessionRegistration.js";
import { ProfileManager } from "../../js/core/profile/profileManager.js";
import { ProfileSyncService } from "../../js/core/profile/profileSyncService.js";
import { StartupSyncService } from "../../js/core/profile/startupSyncService.js";
import { MemberAccessRepository } from "../../js/data/remote/supabase/memberAccessRepository.js";
import { LocalStore } from "../../js/core/storage/localStore.js";
import { I18n } from "../../js/i18n/index.js";
import { Platform } from "../../js/platform/index.js";
import { ThemeManager } from "../../js/ui/theme/themeManager.js";
import { installAddonFetchFallback } from "./services/addonFetch.js";
import { createRouter, navigate, parseHash } from "./lib/router.js";
import { h, icon } from "./lib/dom.js";
import { mountLogin } from "./screens/login.js";
import { mountProfiles } from "./screens/profiles.js";
import { mountHome } from "./screens/home.js";
import { mountSearch } from "./screens/search.js";
import { mountCatalog } from "./screens/catalog.js";
import { mountLibrary } from "./screens/library.js";
import { mountDetail } from "./screens/detail.js";
import { mountSettings } from "./screens/settings.js";
import { mountPlayer } from "./player/player.js";
import { mountInvite } from "./screens/invite.js";
import { Backend } from "./services/backend.js";
import { startRequestWatch } from "./services/requestWatch.js";

const GUEST_KEY = "skipAuthQrGate"; // Same key as the TV app.
const NAV_ITEMS = [
  { route: "home", label: "Home", iconName: "home" },
  { route: "search", label: "Search", iconName: "search" },
  { route: "library", label: "Library", iconName: "video_library" },
  { route: "settings", label: "Settings", iconName: "settings" }
];
const INITIAL_SYNC_KEY = "webInitialSyncProfiles";
const INITIAL_SYNC_WAIT_MS = 8000;
const FULLSCREEN_ROUTES = new Set(["invite", "login", "server", "profiles", "player"]);
// A deployment shared with friends asks for an invite code before anything else.
const INVITE_REQUIRED = /^(1|true|yes)$/i.test(String(globalThis.__NUVIO_ENV__?.NUVIO_REQUIRE_INVITE || ""));

// "loading" until auth settles, then login -> profiles -> app.
let gate = "loading";
let profileEntered = false;
let router = null;
let navItems = [];
let launchHash = null;
let acceptInvite = null;

function isGateRoute(name) {
  return ["invite", "login", "server", "profiles"].includes(name);
}

function renderShell() {
  const outlet = h("main", { id: "outlet", class: "outlet" });
  const buildNav = (className) =>
    h(
      "nav",
      { class: className, "aria-label": "Primary" },
      NAV_ITEMS.map((item) =>
        h(
          "a",
          { href: `#/${item.route}`, class: "nav-item", dataset: { route: item.route } },
          icon(item.iconName),
          h("span", { class: "nav-label" }, item.label)
        )
      )
    );
  const rail = h(
    "aside",
    { class: "nav-rail" },
    h("img", { class: "nav-rail-logo", src: "./assets/brand/app_logo_mark.png", alt: "Nuvio" }),
    buildNav("nav-rail-items")
  );
  const bottom = buildNav("nav-bottom");
  const syncOverlay = h(
    "div",
    { class: "sync-overlay", role: "status", "aria-label": "Loading your account" },
    h("div", { class: "spinner" }),
    h("p", {}, "Loading your addons and library…")
  );
  document.getElementById("app").replaceChildren(rail, outlet, bottom, syncOverlay);
  navItems = [...rail.querySelectorAll(".nav-item"), ...bottom.querySelectorAll(".nav-item")];
  return outlet;
}

function syncChrome(route) {
  document.body.classList.toggle("no-chrome", FULLSCREEN_ROUTES.has(route.name));
  navItems.forEach((item) => {
    const active = item.dataset.route === route.name;
    item.classList.toggle("is-active", active);
    item.querySelector(".icon")?.classList.toggle("icon-filled", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

function enterGate(next) {
  gate = next;
  router.reset();
  const current = parseHash().name;
  if (next === "app") {
    // A reload or deep link returns to where it pointed, once sign-in and profile choice are done.
    const resume = launchHash;
    launchHash = null;
    if (resume) {
      if (resume === location.hash) router.render();
      else location.replace(resume);
      return;
    }
    if (location.hash && !isGateRoute(current)) {
      router.render();
      return;
    }
  }
  const target = next === "login" ? "login" : next === "profiles" ? "profiles" : "home";
  if (current === target && location.hash) router.render();
  else navigate(target, [], null, { replace: true });
}

async function shouldShowProfilePicker() {
  const [profiles, pinStates] = await Promise.all([
    ProfileManager.getProfiles(),
    ProfileSyncService.pullProfileLockStates().catch(() => ({}))
  ]);
  const activeId = ProfileManager.getActiveProfileId();
  const activeHasPin = Boolean(pinStates?.[String(activeId)] || pinStates?.[Number(activeId)]);
  if (ProfileManager.isRememberLastProfileEnabled() && ProfileManager.hasEverSelectedProfile() && !activeHasPin) {
    return false;
  }
  return profiles.length > 1 || activeHasPin;
}

export async function enterApp(profileId = null) {
  const profiles = await ProfileManager.getProfiles();
  const id = profileId ?? ProfileManager.getActiveProfileId() ?? profiles[0]?.id ?? "1";
  await ProfileManager.setActiveProfile(id);
  profileEntered = true;
  StartupSyncService.enableProfileScopedSync();
  await I18n.init("en");
  ThemeManager.apply({ enforceAccess: true, access: MemberAccessRepository.getCachedAccess() });
  void MemberAccessRepository.getAccess().catch(() => null);
  const syncing = StartupSyncService.requestSyncNow({ notifyPullCompleted: true }).catch((error) => {
    console.warn("Profile sync failed", error);
  });
  await waitForFirstSync(id, syncing);
  await startRequestWatch();
  enterGate("app");
}

// The first time a profile opens on this browser its addons exist only on the account, so opening
// a title too early would fail. Later launches use the local copy and sync in the background.
async function waitForFirstSync(profileId, syncing) {
  if (!AuthManager.isAuthenticated) return;
  const done = LocalStore.get(INITIAL_SYNC_KEY, []);
  if (done.includes(String(profileId))) return;
  document.body.classList.add("is-syncing");
  await Promise.race([syncing, new Promise((resolve) => setTimeout(resolve, INITIAL_SYNC_WAIT_MS))]);
  document.body.classList.remove("is-syncing");
  LocalStore.set(INITIAL_SYNC_KEY, [...done, String(profileId)]);
}

async function routeAfterAuth() {
  await ProfileSyncService.pull().catch((error) => console.warn("Profile pull failed", error));
  if (await shouldShowProfilePicker()) enterGate("profiles");
  else await enterApp();
}

export function continueAsGuest() {
  LocalStore.set(GUEST_KEY, true);
  profileEntered = false;
  enterApp("1").catch(() => enterGate("profiles"));
}

export function switchProfile() {
  profileEntered = false;
  enterGate("profiles");
}

export function showLogin() {
  LocalStore.remove(GUEST_KEY);
  profileEntered = false;
  enterGate("login");
}

function onAuthState(state) {
  if (state === AuthState.LOADING) return;
  if (state === AuthState.SIGNED_OUT) {
    StartupSyncService.stop();
    profileEntered = false;
    LocalStore.remove(INITIAL_SYNC_KEY);
    if (LocalStore.get(GUEST_KEY, false)) {
      enterApp().catch(() => enterGate("profiles"));
    } else if (gate !== "login") {
      enterGate("login");
    }
    return;
  }
  if (state === AuthState.AUTHENTICATED) {
    LocalStore.remove(GUEST_KEY);
    StartupSyncService.start({ runInitialPull: false });
    if (!profileEntered) {
      routeAfterAuth().catch((error) => {
        console.warn("Could not resolve the signed-in route", error);
        enterGate("profiles");
      });
    }
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || typeof __NUVIO_WEB_DEV__ === "undefined" || __NUVIO_WEB_DEV__) return;
  // The shell is served from the cache, so the first launch after a release still runs the old code.
  // When the new worker takes over, reload once to switch to it, but never in the middle of a film.
  let reloading = false;
  const reloadWhenIdle = () => {
    if (reloading) return;
    if (parseHash().name === "player") {
      window.addEventListener("hashchange", reloadWhenIdle, { once: true });
      return;
    }
    reloading = true;
    location.reload();
  };
  const register = async () => {
    try {
      // Only a worker replacing an earlier one is an update. The first install needs no reload.
      const existing = await navigator.serviceWorker.getRegistration();
      if (existing?.active) navigator.serviceWorker.addEventListener("controllerchange", reloadWhenIdle);
      const registration = await navigator.serviceWorker.register("./sw.js");
      // A Home Screen app can stay open for days, so it checks for a new version when it comes back.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") registration.update().catch(() => null);
      });
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  };
  // Startup is async, so the load event may already have fired by the time this runs.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

function refreshOnForeground() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && AuthManager.isAuthenticated) {
      StartupSyncService.requestForegroundSync?.();
    }
  });
}

async function boot() {
  if (location.hash && !isGateRoute(parseHash().name)) launchHash = location.hash;
  Platform.init();
  installAddonFetchFallback();
  await I18n.init("en");
  ThemeManager.apply();

  const outlet = renderShell();
  router = createRouter({
    outlet,
    routes: {
      login: mountLogin,
      server: mountLogin,
      profiles: mountProfiles,
      home: mountHome,
      search: mountSearch,
      catalog: mountCatalog,
      library: mountLibrary,
      detail: mountDetail,
      settings: mountSettings,
      player: mountPlayer,
      invite: (node, route) => mountInvite(node, route, { onAccepted: () => acceptInvite?.() })
    },
    guard(route) {
      if (gate === "invite") return route.name === "invite" ? null : "invite";
      if (gate === "login") return route.name === "login" || route.name === "server" ? null : "login";
      if (gate === "profiles") return route.name === "profiles" ? null : "profiles";
      if (gate === "app" && (route.name === "login" || route.name === "server")) return "home";
      return null;
    },
    onChange: syncChrome
  });

  registerServiceWorker();
  if (INVITE_REQUIRED) {
    // A saved session can belong to someone who has since been removed, so it's checked with the
    // server on every launch. A 401 clears it. Being offline doesn't.
    if (Backend.isConnected()) await Backend.me().catch(() => null);
    if (!Backend.isConnected()) await Backend.renewSession();
    // Removed while using the app: the next server call fails and returns them to the first screen.
    window.addEventListener("nuvio:backend-signed-out", () => location.reload());
    if (!Backend.isConnected()) {
      gate = "invite";
      navigate("invite", [], null, { replace: true });
      router.render();
      await new Promise((resolve) => {
        acceptInvite = resolve;
      });
      gate = "loading";
    }
  }
  DeviceSessionRegistration.start?.();
  refreshOnForeground();
  AuthManager.subscribe(onAuthState);
  await AuthManager.bootstrap();
}

boot().catch((error) => {
  console.error("Nuvio failed to start", error);
  document.getElementById("app").replaceChildren(
    h(
      "div",
      { class: "fatal" },
      h("h1", {}, "Nuvio couldn't start"),
      h("p", {}, String(error?.message || error)),
      h("button", { class: "btn btn-primary", onClick: () => location.reload() }, "Reload")
    )
  );
});
