import { PRESENCE_PALETTE, presenceColor } from './presence';

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

describe('presenceColor', () => {
  it('is stable for a user and comes from the palette', () => {
    expect(presenceColor('user-1')).toBe(presenceColor('user-1'));
    expect(PRESENCE_PALETTE).toContain(presenceColor('user-1'));
  });

  it.each([...PRESENCE_PALETTE])('%s carries white text legibly (4.5:1)', (color) => {
    expect(contrastWithWhite(color)).toBeGreaterThanOrEqual(4.5);
  });

  it('has no colour twice', () => {
    expect(new Set(PRESENCE_PALETTE).size).toBe(PRESENCE_PALETTE.length);
  });
});
