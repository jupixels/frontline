import { describe, expect, it } from 'vitest';
import { datan2, dcos, dsin, turnToward, wrapAngle } from '../src/sim/math/dmath';

describe('dmath', () => {
  it('matches Math trig closely', () => {
    for (let a = -20; a <= 20; a += 0.037) {
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-6);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-6);
    }
    for (let y = -5; y <= 5; y += 0.31) {
      for (let x = -5; x <= 5; x += 0.29) {
        expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(2e-5);
      }
    }
  });

  it('wraps and turns', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(turnToward(3, -3, 0.1)).toBeCloseTo(3.1);
  });
});
