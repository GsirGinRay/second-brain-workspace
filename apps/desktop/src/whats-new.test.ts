import assert from "node:assert/strict";
import test from "node:test";
import { LAST_SEEN_VERSION_KEY, RELEASE_HIGHLIGHT_KEYS, consumeUpdateNotice } from "./whats-new";
import { translate } from "./ui-preferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

test("a fresh install does not announce an update", () => {
  const storage = memoryStorage();
  assert.equal(consumeUpdateNotice(storage, "0.6.2"), false);
  assert.equal(storage.values.get(LAST_SEEN_VERSION_KEY), "0.6.2");
});

test("an existing install from before the key existed announces the update once", () => {
  const storage = memoryStorage({ "second-brain.onboardingCompleted": "true" });
  assert.equal(consumeUpdateNotice(storage, "0.6.2"), true);
  assert.equal(consumeUpdateNotice(storage, "0.6.2"), false);
});

test("only a newer version announces an update", () => {
  assert.equal(consumeUpdateNotice(memoryStorage({ [LAST_SEEN_VERSION_KEY]: "0.6.1" }), "0.6.2"), true);
  assert.equal(consumeUpdateNotice(memoryStorage({ [LAST_SEEN_VERSION_KEY]: "0.6.9" }), "0.6.10"), true);
  assert.equal(consumeUpdateNotice(memoryStorage({ [LAST_SEEN_VERSION_KEY]: "0.6.2" }), "0.6.1"), false);
});

test("dev builds and unavailable storage never announce", () => {
  assert.equal(consumeUpdateNotice(memoryStorage({ [LAST_SEEN_VERSION_KEY]: "0.6.1" }), "dev"), false);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
  assert.equal(consumeUpdateNotice(broken, "0.6.2"), false);
});

test("every highlight is translated in both languages", () => {
  for (const key of Object.values(RELEASE_HIGHLIGHT_KEYS).flat()) {
    assert.notEqual(translate("zh-TW", key), key);
    assert.notEqual(translate("en", key), key);
  }
});
