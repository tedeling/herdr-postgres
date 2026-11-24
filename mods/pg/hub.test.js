import test from "node:test";
import assert from "node:assert/strict";
import { BAD_HUB_FILE, WAITING, execOptions, hubError, loadTarget, openCommand, parseTarget } from "./hub.js";

const HUB = (o) => JSON.stringify({ hub: "hub.example", ...o });
test("no registry: local", () => assert.deepEqual(parseTarget(null, null), { mode: "local" }));
test("registry, no hub file: waiting", () => assert.deepEqual(parseTarget("{}", null), { mode: "blocked", message: "Waiting for the sync" }));
test("state local", () => assert.deepEqual(parseTarget("{}", HUB({ state: "local" })), { mode: "local" }));
test("state remote", () => assert.deepEqual(parseTarget("{}", HUB({ state: "remote", machine: "desk" })), { mode: "remote", machine: "desk", hub: "hub.example" }));
test("state missing", () => assert.deepEqual(parseTarget("{}", HUB({ state: "missing" })), { mode: "blocked", message: "Add the hub: hc machine add hub.example" }));
test("bad hub file", () => {
  for (const text of ["{", HUB({ state: "remote" }), HUB({ state: "other" })])
    assert.deepEqual(parseTarget("{}", text), { mode: "blocked", message: BAD_HUB_FILE });
});
test("execOptions", () => {
  assert.deepEqual(execOptions({ mode: "local" }), {});
  assert.deepEqual(execOptions({ mode: "remote", machine: "desk", hub: "hub.example" }), { on: "desk" });
  assert.throws(() => execOptions({ mode: "blocked", message: "Waiting for the sync" }), /Waiting for the sync/);
});
test("hubError", () => {
  assert.equal(hubError({ mode: "remote", machine: "desk", hub: "hub.example" }, new Error("machine unreachable")), "hub.example does not answer (machine unreachable)");
  assert.equal(hubError({ mode: "local" }, new Error("x")), "x");
});
test("openCommand", () => assert.deepEqual(["macos", "darwin", "linux"].map(openCommand), ["open", "open", "xdg-open"]));
test("loadTarget reads both files", async () => {
  const files = { "/a/registry/registry.json": "{}", "/a/hub.json": HUB({ state: "local" }) };
  assert.deepEqual(await loadTarget(async (p) => files[p] ?? null, "/a"), { mode: "local" });
  assert.deepEqual(await loadTarget(async () => { throw new Error("io"); }, "/a"), { mode: "local" });
});
test("copy strings", () => {
  assert.equal(WAITING, "Waiting for the sync");
  assert.equal(BAD_HUB_FILE, "hub.json is not valid. Click the sync line to write it again.");
});
