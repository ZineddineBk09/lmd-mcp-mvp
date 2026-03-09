import type { AuthContext, UserPrivilege } from '../auth/types.js';
import { HttpClient } from './http-client.js';

interface CurrentUserResponse {
  username: string;
  role: string;
  availability: boolean;
  country_code: string;
  country_name: string;
  country: { code: string; name: string };
  isCountryManager: boolean;
  isDispatchManager: boolean;
  privileges: Array<{
    name: string;
    alias: string;
    status: { view: boolean; add: boolean; edit: boolean; delete: boolean };
    state?: string;
    action?: string;
    icon?: string;
    childs?: Array<{
      name: string;
      alias?: string;
      state: string;
      action: string;
    }>;
  }>;
}

interface CacheEntry {
  context: AuthContext;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const authCache = new Map<string, CacheEntry>();

function getCacheKey(token: string, countryCode: string): string {
  return `${token.slice(-16)}:${countryCode}`;
}

export async function fetchCurrentUser(client: HttpClient, token: string, countryCode: string): Promise<AuthContext> {
  const cacheKey = getCacheKey(token, countryCode);
  const cached = authCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  const usernameFromToken = extractUsernameFromToken(token);

  const response = await client.post<CurrentUserResponse>(
    '/admins/currentuser',
    {
      currentUserData: usernameFromToken,
      currentCountryCode: countryCode,
    },
    countryCode,
  );

  const privileges: UserPrivilege[] = (response.privileges ?? []).map((p) => ({
    name: p.name,
    alias: p.alias ?? '',
    status: p.status ?? { view: false, add: false, edit: false, delete: false },
    state: p.state,
    action: p.action,
    icon: p.icon,
    childs: p.childs,
  }));

  const context: AuthContext = {
    token,
    username: response.username,
    role: response.role,
    countryCode: response.country_code ?? countryCode,
    countryName: response.country_name ?? response.country?.name ?? '',
    isCountryManager: response.isCountryManager ?? false,
    isDispatchManager: response.isDispatchManager ?? false,
    privileges,
  };

  authCache.set(cacheKey, {
    context,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return context;
}

function extractUsernameFromToken(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    return payload.username ?? '';
  } catch {
    return '';
  }
}

export function clearAuthCache(): void {
  authCache.clear();
}
