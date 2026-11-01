// Nuvio Web defaults to English everywhere, whatever the phone's language or the account's TV settings
// say. A different subtitle choice in Settings is kept on this device and isn't synced to the account.
import { LocalStore } from "../../../js/core/storage/localStore.js";

const SUBTITLE_LANGUAGE_KEY = "webSubtitleLanguage";
const THREE_LETTER_CODES = {
  en: ["eng"], es: ["spa"], fr: ["fra", "fre"], de: ["deu", "ger"], it: ["ita"], pt: ["por", "pob"],
  nl: ["nld", "dut"], no: ["nor", "nob", "nno"], sv: ["swe"], da: ["dan"], pl: ["pol"], ar: ["ara"],
  hi: ["hin"], ja: ["jpn"]
};

export function getPreferredSubtitleLanguage() {
  return LocalStore.get(SUBTITLE_LANGUAGE_KEY, "en");
}

export function setPreferredSubtitleLanguage(language) {
  LocalStore.set(SUBTITLE_LANGUAGE_KEY, language);
}

export function matchesLanguage(option, language) {
  const value = String(option?.lang || option?.language || "").trim().toLowerCase();
  if (!value) return false;
  const primary = value.split(/[-_]/)[0];
  return primary === language || (THREE_LETTER_CODES[language] || []).includes(primary);
}

// Stable, so each language keeps the order the addons returned.
export function sortSubtitlesByLanguage(options, language) {
  return [...options].sort((a, b) => Number(matchesLanguage(b, language)) - Number(matchesLanguage(a, language)));
}

export function pickEnglishAudio(tracks) {
  const candidates = tracks.filter((track) => matchesLanguage(track, "en") && !/commentary/i.test(track.label || ""));
  return candidates[0] || null;
}
