/** Hafif bellek içi sabit pencere sınırlayıcı (tek süreç). */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number) {}
  hit(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSec: number } {
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 10_000) this.sweep(now);
    const allowed = b.count <= this.limit;
    return { allowed, remaining: Math.max(0, this.limit - b.count), retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  }
  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
  reset() {
    this.buckets.clear();
  }
}
