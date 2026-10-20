import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_GROUPS, isShortcutHelpKey } from "./shortcuts-help";
import { translate } from "./ui-preferences";

const plain = { ctrlKey: false, metaKey: false, altKey: false };

test("? opens the shortcut list only outside text fields and dialogs", () => {
  assert.equal(isShortcutHelpKey({ key: "?", ...plain }, false, false), true);
  assert.equal(isShortcutHelpKey({ key: "?", ...plain }, true, false), false, "typing a question mark stays text");
  assert.equal(isShortcutHelpKey({ key: "?", ...plain }, false, true), false, "another dialog is open");
  assert.equal(isShortcutHelpKey({ key: "/", ...plain }, false, false), false, "/ still opens search");
  assert.equal(isShortcutHelpKey({ key: "?", ...plain, ctrlKey: true }, false, false), false);
});

test("every shortcut label is translated in both languages", () => {
  const keys = SHORTCUT_GROUPS.flatMap((group) => [group.titleKey, ...group.items.map((item) => item.labelKey)]);
  for (const language of ["zh-TW", "en"] as const) {
    for (const key of [...keys, "shortcuts.title", "shortcuts.open"]) {
      assert.notEqual(translate(language, key), key, `${language} is missing ${key}`);
    }
  }
});
