import type { MetadataRoute } from 'next';

/** Published pages (`/published/…`) are meant to be found; everything behind a login, a secret link or an internal route is not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/published/'],
      disallow: [
        '/workspaces/',
        '/edit-link/',
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
