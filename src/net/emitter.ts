/** Minimal typed event emitter. `on` returns an unsubscribe function. */
export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<(e: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as (e: never) => void);
    return () => this.off(type, fn);
  }

  once<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void {
    const off = this.on(type, (e) => {
      off();
      fn(e);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): void {
    this.handlers.get(type)?.delete(fn as (e: never) => void);
  }

  emit<K extends keyof Events>(type: K, e: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (e: Events[K]) => void)(e);
      } catch (err) {
        console.error(`[net] ${String(type)} handler failed`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
