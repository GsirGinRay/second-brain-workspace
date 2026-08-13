import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../../../docs/fixtures/canonical-signature-v1.json" with { type: "json" };
import { canonicalizeDeviceRequest } from "@second-brain/brain-core";

test("desktop shared signing input matches the locked canonical fixture", () => {
  const canonical = canonicalizeDeviceRequest({
    method: fixture.request.method,
    path: fixture.request.path,
    query: [],
    timestamp: Number(fixture.request.timestamp),
    nonce: fixture.request.nonce,
    contentType: fixture.request.contentType,
    bodySha256: fixture.request.bodySha256,
  });

  assert.equal(canonical, fixture.canonicalUtf8);
});
