export interface Clock { now(): number }
export class SystemClock implements Clock { now() { return Date.now(); } }
export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}
