import type { MetadataRoute } from 'next';

/** Published pages (`/p/…`) are meant to be found; everything behind a login, a secret link or an internal route is not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/p/'],
      disallow: [
        '/w/',
        '/e/',
        '/invite/',
        '/mock-checkout/',
        '/notifications',
        '/shared',
        '/api/',
        '/internal/',
        '/media/',
      ],
    },
  };
}
