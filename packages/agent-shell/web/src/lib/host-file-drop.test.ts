import { describe, expect, it } from 'vitest';
import { dropPointHitsRect } from './host-file-drop';

const box = { left: 360, right: 1100, top: 880, bottom: 960 };

describe('dropPointHitsRect', () => {
  it('accepts AppKit points that already match CSS pixels', () => {
    expect(dropPointHitsRect({ x: 400, y: 900 }, box, 2)).toBe(true);
  });

  it('accepts device pixels on a retina window', () => {
    expect(dropPointHitsRect({ x: 800, y: 1800 }, box, 2)).toBe(true);
  });

  it('rejects a drop outside the composer at either scale', () => {
    expect(dropPointHitsRect({ x: 40, y: 40 }, box, 2)).toBe(false);
  });
});
