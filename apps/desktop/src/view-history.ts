/**
 * Browser-style back/forward history for the sidebar views, so a detour into
 * knowledge or settings can return to the exact view the user came from.
 */
export const VIEW_HISTORY_LIMIT = 30;

export interface ViewHistory<V extends string> {
  current: V;
  back: V[];
  forward: V[];
}

export function emptyViewHistory<V extends string>(current: V): ViewHistory<V> {
  return { current, back: [], forward: [] };
}

export function navigateTo<V extends string>(history: ViewHistory<V>, next: V): ViewHistory<V> {
  if (next === history.current) return history;
  return {
    current: next,
    back: [...history.back, history.current].slice(-VIEW_HISTORY_LIMIT),
    forward: [],
  };
}

export function goBack<V extends string>(history: ViewHistory<V>): ViewHistory<V> {
  const previous = history.back.at(-1);
  if (previous === undefined) return history;
  return {
    current: previous,
    back: history.back.slice(0, -1),
    forward: [history.current, ...history.forward],
  };
}

export function goForward<V extends string>(history: ViewHistory<V>): ViewHistory<V> {
  const [next, ...rest] = history.forward;
  if (next === undefined) return history;
  return {
    current: next,
    back: [...history.back, history.current].slice(-VIEW_HISTORY_LIMIT),
    forward: rest,
  };
}
