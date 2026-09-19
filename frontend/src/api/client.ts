const RAW_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api/v1";

export const API_BASE = RAW_BASE.replace(/\/$/, "");
export const API_ORIGIN = new URL(API_BASE).origin;

// Access Token 只放在内存里：刷新页面时用 HttpOnly 的 refresh cookie 换一次新的，
// 这样即使页面被注入了脚本，也拿不到长期有效的凭证。
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly traceId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, traceId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.traceId = traceId;
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
  traceId?: string;
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const payload = (await response.json()) as ApiEnvelope<{ accessToken: string }>;
        if (payload.success && payload.data?.accessToken) {
          setAccessToken(payload.data.accessToken);
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => {
        // 允许下一次需要时重新发起刷新
        setTimeout(() => {
          refreshPromise = null;
        }, 0);
      });
  }
  return refreshPromise;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  query?: Record<string, unknown>;
  skipAuthRetry?: boolean;
}

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return "";
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }

  const text = params.toString();
  return text ? `?${text}` : "";
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : ({} as ApiEnvelope<T>);

  if (!response.ok || payload.success === false) {
    const error = payload.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `请求失败（${response.status}）`,
      error?.details,
      payload.traceId,
    );
  }

  return payload.data;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};

  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${path}${buildQuery(options.query)}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    credentials: "include",
  });

  // Access Token 过期时自动续期一次，用户无感
  if (response.status === 401 && !options.skipAuthRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request<T>(path, { ...options, skipAuthRetry: true });
    }
  }

  return parse<T>(response);
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string, query?: Record<string, unknown>) =>
    request<T>(path, { method: "DELETE", query }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: "POST", formData }),
};

export async function bootstrapSession(): Promise<boolean> {
  return refreshAccessToken();
}

// 后端返回的是 /api/v1/media/... 这样的相对路径，这里补上服务源
export function mediaUrl(path: string | undefined | null): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_ORIGIN}${path}`;
}
