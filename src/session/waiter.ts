export interface Waiters<K, T> {
  register: (key: K, callback: (data: T) => void) => () => void;
  notifyFirst: (key: K, data: T) => void;
  notifyAll: (key: K, data: T) => void;
  has: (key: K) => boolean;
  count: (key: K) => number;
  clear: (key: K) => void;
}

type WaiterMap<K, T> = Map<K, Array<(data: T) => void>>;

function registerWaiter<K, T>(waiters: WaiterMap<K, T>, key: K, callback: (data: T) => void): () => void {
  const current = waiters.get(key) || [];
  waiters.set(key, [...current, callback]);

  return () => {
    const callbacks = waiters.get(key);
    if (!callbacks) return;

    const idx = callbacks.indexOf(callback);
    if (idx >= 0) {
      const remaining = [...callbacks.slice(0, idx), ...callbacks.slice(idx + 1)];
      if (remaining.length === 0) {
        waiters.delete(key);
      } else {
        waiters.set(key, remaining);
      }
    }
  };
}

function notifyFirstWaiter<K, T>(waiters: WaiterMap<K, T>, key: K, data: T): void {
  const callbacks = waiters.get(key);
  if (!callbacks || callbacks.length === 0) return;

  const [first, ...rest] = callbacks;
  first(data);

  if (rest.length === 0) {
    waiters.delete(key);
  } else {
    waiters.set(key, rest);
  }
}

function notifyAllWaiters<K, T>(waiters: WaiterMap<K, T>, key: K, data: T): void {
  const callbacks = waiters.get(key);
  if (!callbacks) return;

  for (const callback of callbacks) {
    callback(data);
  }

  waiters.delete(key);
}

export function createWaiters<K, T>(): Waiters<K, T> {
  const waiters: WaiterMap<K, T> = new Map();

  return {
    register: (key, callback) => registerWaiter(waiters, key, callback),
    notifyFirst: (key, data) => notifyFirstWaiter(waiters, key, data),
    notifyAll: (key, data) => notifyAllWaiters(waiters, key, data),
    has(key: K): boolean {
      const callbacks = waiters.get(key);
      return callbacks !== undefined && callbacks.length > 0;
    },
    count(key: K): number {
      return waiters.get(key)?.length ?? 0;
    },
    clear(key: K): void {
      waiters.delete(key);
    },
  };
}

export type WaitResult<T> = { ok: true; data: T } | { ok: false; reason: "timeout" };

export function waitForResponse<K, T>(waiters: Waiters<K, T>, key: K, timeoutMs: number): Promise<WaitResult<T>> {
  return new Promise((resolve) => {
    const cleanup = waiters.register(key, (data) => {
      clearTimeout(timeoutId);
      resolve({ ok: true, data });
    });

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}
