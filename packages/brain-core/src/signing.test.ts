import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeDeviceRequest,
  canonicalizeQuery,
  normalizeDeviceContentType,
  normalizeDevicePath,
} from "./signing";

test("device signing canonical request is stable across method/content/query normalization", () => {
  const bodySha256 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const canonical = canonicalizeDeviceRequest({
    method: "post",
    path: "/api/brain/device/sync/plan",
    query: [
      ["z", "two words"],
      ["a", "2"],
      ["a", "1"],
    ],
    timestamp: 1_765_000_000,
    nonce: "nonce-012345678901234567890123",
    contentType: " Application/JSON ; charset=UTF-8 ",
    bodySha256: bodySha256.toUpperCase(),
  });

  assert.equal(
    canonical,
    `v1\nPOST\n/api/brain/device/sync/plan\na=1&a=2&z=two%20words\n1765000000\nnonce-012345678901234567890123\napplication/json\n${bodySha256}`,
  );
});

test("device signing query ordering preserves duplicate pairs and encodes RFC3986", () => {
  assert.equal(
    canonicalizeQuery([["q", "a+b"], ["q", "a b"], ["x/y", "!"], ["q", "a"]]),
    "q=a&q=a%20b&q=a%2Bb&x%2Fy=%21",
  );
});

test("device signing path/content type normalization is explicit", () => {
  assert.equal(normalizeDevicePath("/api/brain/device/state?ignored=1"), "/api/brain/device/state");
  assert.equal(normalizeDevicePath(""), "/");
  assert.equal(normalizeDeviceContentType("  APPLICATION/JSON;  charset=UTF-8  "), "application/json");
  assert.throws(() => normalizeDevicePath("relative/path"), /absolute path/i);
});
