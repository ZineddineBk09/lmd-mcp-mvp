import { logTool } from '../utils/tool-logger.js';

export class ApiAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiAuthError';
    this.status = status;
  }
}

export interface HttpClientOptions {
  baseURL: string;
  token: string;
  countryCode?: string;
  /** Forward the entire raw Cookie header from the browser request to backend API calls (carries IAP tokens, session, etc.) */
  rawCookies?: string;
  /** @deprecated Use rawCookies instead. Kept for backward compat with env-only setups. */
  iapCookie?: string;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  countryCode?: string;
}

export class HttpClient {
  private baseURL: string;
  private token: string;
  private defaultCountryCode: string;
  private cookieHeader: string | undefined;

  constructor(options: HttpClientOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, '');
    this.token = options.token;
    this.defaultCountryCode = options.countryCode ?? 'DZ';
    this.cookieHeader = options.rawCookies || options.iapCookie;
  }

  private buildHeaders(countryCode?: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: this.token,
      'content-type': 'application/json',
      accept: 'application/json',
      'country-code': countryCode ?? this.defaultCountryCode,
    };
    if (this.cookieHeader) {
      headers['cookie'] = this.cookieHeader;
    }
    return headers;
  }

  private buildURL(path: string, query?: Record<string, string>): string {
    const url = new URL(path, this.baseURL);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildURL(options.path, options.query);
    const headers = this.buildHeaders(options.countryCode);

    const init: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    logTool({
      phase: 'api_call',
      meta: {
        method: options.method,
        path: options.path,
        url,
        body: options.body,
        countryCode: options.countryCode ?? this.defaultCountryCode,
      },
    });

    const start = Date.now();
    const response = await fetch(url, init);
    const elapsed = Date.now() - start;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logTool({
        phase: 'api_response',
        duration_ms: elapsed,
        error: `${response.status} ${response.statusText}`,
        result: text.slice(0, 500),
        meta: { method: options.method, path: options.path, status: response.status },
      });
      if (response.status === 401 || response.status === 403) {
        throw new ApiAuthError(response.status, `API ${options.method} ${options.path} failed (${response.status}): ${text}`);
      }
      throw new Error(`API ${options.method} ${options.path} failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as T;

    logTool({
      phase: 'api_response',
      duration_ms: elapsed,
      result: data,
      meta: { method: options.method, path: options.path, status: response.status },
    });

    return data;
  }

  async post<T = unknown>(path: string, body?: unknown, countryCode?: string): Promise<T> {
    return this.request<T>({ method: 'POST', path, body, countryCode });
  }

  async get<T = unknown>(path: string, query?: Record<string, string>, countryCode?: string): Promise<T> {
    return this.request<T>({ method: 'GET', path, query, countryCode });
  }

  async put<T = unknown>(path: string, body?: unknown, countryCode?: string): Promise<T> {
    return this.request<T>({ method: 'PUT', path, body, countryCode });
  }

  updateToken(token: string): void {
    this.token = token;
  }

  updateCountryCode(countryCode: string): void {
    this.defaultCountryCode = countryCode;
  }
}

let _client: HttpClient | null = null;

export function getHttpClient(): HttpClient {
  if (!_client) {
    const baseURL = process.env.YASSIR_API_BASE_URL;
    if (!baseURL) {
      throw new Error('YASSIR_API_BASE_URL is required. Set it in .env (e.g., https://food-preprod-admin.yassir.io)');
    }
    const token = process.env.YASSIR_AUTH_TOKEN ?? '';
    const countryCode = process.env.YASSIR_COUNTRY_CODE ?? 'DZ';
    const iapCookie = process.env.YASSIR_IAP_COOKIE || undefined;
    _client = new HttpClient({ baseURL, token, countryCode, iapCookie });
  }
  return _client;
}

export function initHttpClient(options: HttpClientOptions): HttpClient {
  _client = new HttpClient(options);
  return _client;
}
