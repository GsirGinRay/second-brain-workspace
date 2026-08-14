import assert from "node:assert/strict";
import test from "node:test";
import { deleteTaskLocalFirst } from "./task-deletion";

test("an unauthorized Publisher cannot block a successful local deletion", async () => {
  const calls: string[] = [];

  const outcome = await deleteTaskLocalFirst({
    deleteLocal: async () => {
      calls.push("local");
      return true;
    },
    deleteRemote: async () => {
      calls.push("remote");
      throw new Error("HTTP 401 · DEVICE_UNAUTHORIZED");
    },
  });

  assert.deepEqual(calls, ["local", "remote"]);
  assert.equal(outcome.localDeleted, true);
  assert.equal(outcome.remoteDeleted, false);
  assert.equal(outcome.needsPairing, true);
  assert.match(outcome.remoteError ?? "", /DEVICE_UNAUTHORIZED/);
});

test("remote deletion is not attempted when the local Markdown write fails", async () => {
  let remoteCalled = false;

  const outcome = await deleteTaskLocalFirst({
    deleteLocal: async () => false,
    deleteRemote: async () => {
      remoteCalled = true;
    },
  });

  assert.equal(remoteCalled, false);
  assert.deepEqual(outcome, {
    localDeleted: false,
    remoteDeleted: false,
    needsPairing: false,
    remoteError: null,
  });
});

test("local-only deletion succeeds without a Publisher client", async () => {
  const outcome = await deleteTaskLocalFirst({
    deleteLocal: async () => true,
  });

  assert.deepEqual(outcome, {
    localDeleted: true,
    remoteDeleted: null,
    needsPairing: false,
    remoteError: null,
  });
});
