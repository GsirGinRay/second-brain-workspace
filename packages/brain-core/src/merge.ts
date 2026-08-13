export type MergeStatus =
  | "unchanged"
  | "local"
  | "server"
  | "merged"
  | "conflict";

export interface MergeResult<T> {
  status: MergeStatus;
  value: T | null;
  conflicts: string[];
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setOrDelete<T extends object, K extends keyof T>(
  value: T,
  key: K,
  next: T[K] | undefined,
): void {
  if (next === undefined) delete value[key];
  else value[key] = next;
}

function mergeKeys<T extends { id: string | null }>(
  base: T,
  local: T,
  server: T,
  fields?: Array<keyof T>,
): Array<keyof T> {
  if (fields) return fields.filter((key) => key !== "id");
  return [
    ...new Set(
      [...Object.keys(base), ...Object.keys(local), ...Object.keys(server)].filter(
        (key) => key !== "id",
      ),
    ),
  ] as Array<keyof T>;
}

export function mergeEntity<T extends { id: string | null }>(
  base: T,
  local: T,
  server: T,
  fields?: Array<keyof T>,
): MergeResult<T> {
  const value = { ...base };
  const conflicts: string[] = [];
  let localChanged = false;
  let serverChanged = false;

  for (const key of mergeKeys(base, local, server, fields)) {
    const baseValue = base[key];
    const localValue = local[key];
    const serverValue = server[key];
    const localHas = hasOwn(local, key);
    const serverHas = hasOwn(server, key);
    const baseHas = hasOwn(base, key);

    if (equal(localValue, serverValue) && localHas === serverHas) {
      setOrDelete(value, key, localHas ? localValue : undefined);
      continue;
    }
    if (equal(localValue, baseValue) && localHas === baseHas) {
      setOrDelete(value, key, serverHas ? serverValue : undefined);
      serverChanged = !equal(serverValue, baseValue) || serverHas !== baseHas;
      continue;
    }
    if (equal(serverValue, baseValue) && serverHas === baseHas) {
      setOrDelete(value, key, localHas ? localValue : undefined);
      localChanged = !equal(localValue, baseValue) || localHas !== baseHas;
      continue;
    }
    conflicts.push(String(key));
  }

  if (conflicts.length) return { status: "conflict", value: null, conflicts };
  if (!localChanged && !serverChanged) {
    return { status: "unchanged", value, conflicts };
  }
  return {
    status: localChanged && serverChanged ? "merged" : localChanged ? "local" : "server",
    value,
    conflicts,
  };
}

export function mergeSnapshots<T extends { id: string | null }>(
  base: T[],
  local: T[],
  server: T[],
  fields?: Array<keyof T>,
): { items: T[]; conflicts: Array<{ id: string; fields: string[] }> } {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const serverMap = new Map(server.map((item) => [item.id, item]));
  const ids = [
    ...new Set([
      ...base.map((item) => item.id),
      ...local.map((item) => item.id),
      ...server.map((item) => item.id),
    ]),
  ];
  const items: T[] = [];
  const conflicts: Array<{ id: string; fields: string[] }> = [];

  for (const id of ids) {
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    const serverItem = serverMap.get(id);

    if (!baseItem) {
      if (!localItem && !serverItem) continue;
      if (!localItem || !serverItem) {
        items.push(localItem ?? serverItem!);
        continue;
      }
      const result = mergeEntity({ id } as T, localItem, serverItem, fields);
      if (result.value) items.push(result.value);
      else conflicts.push({ id: String(id), fields: result.conflicts });
      continue;
    }

    if (!localItem && !serverItem) continue;
    if (!localItem) {
      if (serverItem) items.push(serverItem);
      continue;
    }
    if (!serverItem) {
      items.push(localItem);
      continue;
    }

    const result = mergeEntity(baseItem, localItem, serverItem, fields);
    if (result.value) items.push(result.value);
    else conflicts.push({ id: String(id), fields: result.conflicts });
  }

  return { items, conflicts };
}
