import { loadToken } from './auth.js';

const DEFAULT_BASE_URL = 'https://agents.hot';

export class PlatformApiError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

/** User-friendly error messages for known error codes */
const ERROR_HINTS: Record<string, string> = {
  unauthorized: 'Not authenticated. Run `agent-bridge login` first.',
  forbidden: 'You don\'t own this agent.',
  not_found: 'Agent not found.',
  agent_offline: 'Agent must be online for first publish. Run `agent-bridge connect` first.',
  email_required: 'Email required. Visit https://agents.hot/settings to add one.',
  github_required: 'GitHub account required. Visit https://agents.hot/settings to link one.',
  validation_error: 'Invalid input. Check your skill.json or command flags.',
  permission_denied: 'You don\'t have permission to modify this skill.',
  file_too_large: 'Package file exceeds the 50MB limit.',
};

export class PlatformClient {
  private token: string;
  private baseUrl: string;

  constructor(token?: string, baseUrl?: string) {
    const resolved = token ?? loadToken();
    if (!resolved) {
      throw new PlatformApiError(401, 'unauthorized', ERROR_HINTS.unauthorized);
    }
    this.token = resolved;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async del<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }

  async postFormData<T>(path: string, formData: FormData): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: formData,
      });
    } catch (err) {
      throw new PlatformApiError(0, 'network_error', `Network error: ${(err as Error).message}`);
    }

    return this.handleResponse<T>(res);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new PlatformApiError(0, 'network_error', `Network error: ${(err as Error).message}`);
    }

    return this.handleResponse<T>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let errorCode = 'unknown';
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        errorCode = data.error ?? errorCode;
        message = data.error_description ?? data.message ?? message;
      } catch {
        // non-JSON error body
      }

      // Use friendly hint if available
      const hint = ERROR_HINTS[errorCode];
      throw new PlatformApiError(res.status, errorCode, hint ?? message);
    }

    return res.json() as Promise<T>;
  }
}

/** Create a PlatformClient, throwing a user-friendly error if not logged in */
export function createClient(baseUrl?: string): PlatformClient {
  return new PlatformClient(undefined, baseUrl);
}
