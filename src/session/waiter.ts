export interface Waiters<K, T> {
  register: (key: K, callback: (payload: T) => void) => () => void;
  notifyFirst: (key: K, payload: T) => void;
  notifyAll: (key: K, payload: T) => void;
  has: (key: K) => boolean;
  count: (key: K) => number;
  clear: (key: K) => void;
}

type WaiterRegistry<K, T> = Map<K, Array<(payload: T) => void>>;

function registerWaiter<K, T>(waiters: WaiterRegistry<K, T>, key: K, callback: (payload: T) => void): () => void {
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

function notifyFirstWaiter<K, T>(waiters: WaiterRegistry<K, T>, key: K, payload: T): void {
  const callbacks = waiters.get(key);
  if (!callbacks || callbacks.length === 0) return;

  const [first, ...rest] = callbacks;
  first(payload);

  if (rest.length === 0) {
    waiters.delete(key);
  } else {
    waiters.set(key, rest);
  }
}

function notifyAllWaiters<K, T>(waiters: WaiterRegistry<K, T>, key: K, payload: T): void {
  const callbacks = waiters.get(key);
  if (!callbacks) return;

  for (const callback of callbacks) {
    callback(payload);
  }

  waiters.delete(key);
}

export function createWaiters<K, T>(): Waiters<K, T> {
  const waiters: WaiterRegistry<K, T> = new Map();

  return {
    register: (key, callback) => registerWaiter(waiters, key, callback),
    notifyFirst: (key, payload) => notifyFirstWaiter(waiters, key, payload),
    notifyAll: (key, payload) => notifyAllWaiters(waiters, key, payload),
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

export type WaitResult<T> = { ok: true; payload: T } | { ok: false; reason: "timeout" };

export function waitForResponse<K, T>(waiters: Waiters<K, T>, key: K, timeoutMs: number): Promise<WaitResult<T>> {
  return new Promise((resolve) => {
    const cleanup = waiters.register(key, (payload) => {
      clearTimeout(timeoutId);
      resolve({ ok: true, payload });
    });

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}
