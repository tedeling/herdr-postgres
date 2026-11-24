// Decides where a panel runs: on this computer, on the hub, or not at all.
// This file does not import "herdr", so that node can test it.

/** @typedef {{ mode: "local" } | { mode: "remote", machine: string, hub: string } | { mode: "blocked", message: string }} Target */

export const WAITING = "Waiting for the sync";
export const BAD_HUB_FILE = "hub.json is not valid. Click the sync line to write it again.";

const blocked = (message) => ({ mode: "blocked", message });

/**
 * Chooses the target from the text of the two files. Only the existence of `registryText` counts.
 * @param {string | null} registryText
 * @param {string | null} hubText
 * @returns {Target}
 */
export function parseTarget(registryText, hubText) {
  if (registryText === null) return { mode: "local" };
  if (hubText === null) return blocked(WAITING);
  let hub;
  try {
    hub = JSON.parse(hubText);
  } catch {
    return blocked(BAD_HUB_FILE);
  }
  if (!hub || typeof hub !== "object" || typeof hub.hub !== "string") return blocked(BAD_HUB_FILE);
  if (hub.state === "local") return { mode: "local" };
  if (hub.state === "missing") return blocked(ADD_HUB(hub.hub));
  if (hub.state === "remote" && typeof hub.machine === "string" && hub.machine) {
    return { mode: "remote", machine: hub.machine, hub: hub.hub };
  }
  return blocked(BAD_HUB_FILE);
}

const ADD_HUB = (hub) => `Add the hub: hc machine add ${hub}`;
const NO_ANSWER = (hub, reason) => `${hub} does not answer (${reason})`;

/**
 * Reads the registry file and the hub file, then chooses the target. A rejected read counts as no file.
 * @param {(path: string) => Promise<string | null>} readText
 * @param {string} appHome
 * @returns {Promise<Target>}
 */
export async function loadTarget(readText, appHome) {
  const read = (path) => readText(path).catch(() => null);
  const [registryText, hubText] = await Promise.all([
    read(`${appHome}/registry/registry.json`),
    read(`${appHome}/hub.json`),
  ]);
  return parseTarget(registryText, hubText);
}

/**
 * Gives the options for the exec call. Throws when the target is blocked.
 * @param {Target} target
 * @returns {{ on?: string }}
 */
export function execOptions(target) {
  if (target.mode === "blocked") throw new Error(target.message);
  return target.mode === "remote" ? { on: target.machine } : {};
}

/**
 * Gives the message for a failed command.
 * @param {Target} target
 * @param {unknown} error
 * @returns {string}
 */
export function hubError(target, error) {
  const reason = error instanceof Error ? error.message : String(error);
  return target.mode === "remote" ? NO_ANSWER(target.hub, reason) : reason;
}

/** @param {string} platform @returns {"open" | "xdg-open"} */
export const openCommand = (platform) => (platform === "darwin" || platform === "macos" ? "open" : "xdg-open");
