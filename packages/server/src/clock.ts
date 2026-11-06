/** Injectable clock — tests move time for lockout, trash window and purge. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const DAY_MS = 24 * 60 * 60 * 1000;
