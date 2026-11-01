import { addonRepository } from "../../../js/data/repository/addonRepository.js";

// Uses cached manifests when all of them are there, for a fast start. Otherwise (first run, or a
// newly synced addon) it waits for the network, so a partial cache never hides an installed addon.
export async function loadInstalledAddons(options = {}) {
  const cached = await addonRepository.getInstalledAddons({ ...options, staleWhileRevalidate: true });
  const expected = addonRepository.getInstalledAddonUrls().filter((url) => addonRepository.isAddonEnabled(url));
  return cached.length >= expected.length ? cached : addonRepository.getInstalledAddons(options);
}
