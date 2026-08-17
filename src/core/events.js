/**
 * Minimal synchronous event bus. Listeners fire in registration order.
 * A listener that throws is logged and removed so one bad system can't kill the frame.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.map = new Map();
  }

  on(name, fn) {
    let set = this.map.get(name);
    if (!set) this.map.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const un = this.on(name, (p) => { un(); fn(p); });
    return un;
  }

  off(name, fn) {
    const set = this.map.get(name);
    if (set) set.delete(fn);
  }

  emit(name, payload) {
    const set = this.map.get(name);
    if (!set || set.size === 0) return;
    // Copy so listeners may unsubscribe during dispatch.
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener for "${name}" threw:`, err);
        set.delete(fn);
      }
    }
  }

  clear() { this.map.clear(); }
}
