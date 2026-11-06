// The engine `manual` step marker as the cloud stores it (ADR-037): string fields only, clipped.
import { describe, expect, it } from 'vitest';
import { manualMarker } from '../src/runs.js';

describe('manualMarker', () => {
  it('keeps instruction and a non-empty reason, drops other keys', () => {
    expect(manualMarker({ instruction: '로고 확인', reason: '사람 판단', extra: 1 })).toEqual({ instruction: '로고 확인', reason: '사람 판단' });
    expect(manualMarker({ instruction: '로고 확인', reason: '' })).toEqual({ instruction: '로고 확인' });
    expect(manualMarker({ instruction: '로고 확인', reason: 3 })).toEqual({ instruction: '로고 확인' });
  });

  it('is undefined when absent or malformed', () => {
    for (const v of [undefined, null, 'text', 1, {}, { instruction: 7 }, { reason: 'x' }]) expect(manualMarker(v)).toBeUndefined();
  });

  it('clips long text', () => {
    const m = manualMarker({ instruction: 'a'.repeat(3000), reason: 'b'.repeat(3000) });
    expect(m?.instruction).toHaveLength(2000);
    expect(m?.reason).toHaveLength(2000);
  });
});
