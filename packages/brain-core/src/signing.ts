/**
 * Transport-neutral Ed25519 request-signing contract.
 *
 * The canonical request is UTF-8 encoded as eight lines with no trailing
 * newline: version, METHOD, PATH, QUERY, UNIX_TIMESTAMP, NONCE,
 * CONTENT_TYPE, and the lowercase SHA-256 hash of the raw request body.
 */

export const DEVICE_SIGNATURE_HEADERS = {
  deviceId: "X-Brain-Device-Id",
  timestamp: "X-Brain-Timestamp",
  nonce: "X-Brain-Nonce",
  signature: "X-Brain-Signature",
} as const;
export const DEVICE_CANONICAL_VERSION = "v1";

export interface DeviceCanonicalRequestInput {
  method: string;
  path: string;
  query?: ReadonlyArray<readonly [string, string]>;
  timestamp: number;
  nonce: string;
  contentType?: string;
  bodySha256: string;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function normalizeDevicePath(path: string): string {
  const pathOnly = path.split("?", 1)[0] ?? "";
  if (pathOnly === "") return "/";
  if (
    !pathOnly.startsWith("/")
    || pathOnly.includes("\\")
    || pathOnly.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Device signing path must be a normalized absolute path");
  }
  return pathOnly;
}

export function canonicalizeQuery(
  query: ReadonlyArray<readonly [string, string]> = [],
): string {
  return [...query]
    .map(([key, value]) => [String(key), String(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const left = `${encodeRfc3986(leftKey)}\u0000${encodeRfc3986(leftValue)}`;
      const right = `${encodeRfc3986(rightKey)}\u0000${encodeRfc3986(rightValue)}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

export function normalizeDeviceContentType(value = ""): string {
  return (value.split(";", 1)[0] ?? "").trim().toLowerCase();
}

export function canonicalizeDeviceRequest(input: DeviceCanonicalRequestInput): string {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error("Device signing timestamp must be a safe integer");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.bodySha256)) {
    throw new Error("Device signing body hash must be SHA-256 hex");
  }
  const method = input.method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error("Device signing method is invalid");
  return [
    DEVICE_CANONICAL_VERSION,
    method,
    normalizeDevicePath(input.path),
    canonicalizeQuery(input.query),
    String(input.timestamp),
    input.nonce,
    normalizeDeviceContentType(input.contentType),
    input.bodySha256.toLowerCase(),
  ].join("\n");
}
