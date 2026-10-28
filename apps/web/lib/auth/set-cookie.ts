interface ParsedCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  maxAge?: number;
  expires?: Date;
}

/** Parses one `Set-Cookie` header so it can be replayed through `cookies().set` with the same attributes. */
export function parseSetCookie(header: string): ParsedCookie | undefined {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return undefined;
  const cookie: ParsedCookie = {
    name: pair.slice(0, eq),
    value: safeDecode(pair.slice(eq + 1)),
  };
  for (const attribute of attributes) {
    const idx = attribute.indexOf('=');
    const key = (idx === -1 ? attribute : attribute.slice(0, idx)).toLowerCase();
    const value = idx === -1 ? '' : attribute.slice(idx + 1);
    switch (key) {
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite': {
        const sameSite = value.toLowerCase();
        if (sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none') {
          cookie.sameSite = sameSite;
        }
        break;
      }
      case 'path':
        cookie.path = value;
        break;
      case 'max-age': {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) cookie.maxAge = seconds;
        break;
      }
      case 'expires': {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) cookie.expires = date;
        break;
      }
    }
  }
  return cookie;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseSetCookies(headers: Headers): ParsedCookie[] {
  return headers
    .getSetCookie()
    .map(parseSetCookie)
    .filter((cookie): cookie is ParsedCookie => cookie !== undefined);
}
