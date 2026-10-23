import { generateSlug } from './slug';

describe('generateSlug', () => {
  it.each([
    ['Acme Inc.', /^acme-inc-[0-9a-f]{6}$/],
    ['  Café  Déjà vu ', /^cafe-deja-vu-[0-9a-f]{6}$/],
    ['Робочий простір', /^workspace-[0-9a-f]{6}$/],
    ['---', /^workspace-[0-9a-f]{6}$/],
    ['x'.repeat(100), /^x{40}-[0-9a-f]{6}$/],
  ])('%j', (name, pattern) => {
    expect(generateSlug(name)).toMatch(pattern);
  });

  it('is random per call', () => {
    expect(generateSlug('Same')).not.toBe(generateSlug('Same'));
  });
});
