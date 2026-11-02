// Tells the owner when someone is waiting for access: a dot on Settings and a one-time notice.
import { toast } from "../lib/dom.js";
import { Backend } from "./backend.js";

const CHECK_EVERY_MS = 60000;
let timer = 0;
let isAdmin = false;
const announced = new Set();

export function refreshRequestBadge(count) {
  document.querySelectorAll('.nav-item[data-route="settings"]').forEach((item) => item.classList.toggle("has-badge", count > 0));
}

export function isOwner() {
  return isAdmin;
}

async function check() {
  if (document.visibilityState !== "visible" || !Backend.isConnected()) return;
  const { requests } = await Backend.pendingRequests();
  refreshRequestBadge(requests.length);
  const fresh = requests.filter((request) => !announced.has(request.id));
  fresh.forEach((request) => announced.add(request.id));
  if (fresh.length) {
    toast(fresh.length === 1 ? `${fresh[0].name} is asking for access. See Settings → People.` : `${fresh.length} people are asking for access. See Settings → People.`);
  }
}

export async function startRequestWatch() {
  clearInterval(timer);
  try {
    isAdmin = Backend.isConnected() && (await Backend.me()).admin === true;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) return;
  check().catch(() => null);
  timer = setInterval(() => check().catch(() => null), CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", () => check().catch(() => null));
}
