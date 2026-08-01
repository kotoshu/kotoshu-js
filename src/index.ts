/**
 * Kotoshu HTTP API client (TypeScript).
 *
 * Works in Node 18+, Deno, Bun, and modern browsers (uses fetch).
 */

export interface Suggestion {
  word: string;
  distance: number;
  confidence: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface WordError {
  word: string;
  position: number | null;
  suggestions: Suggestion[];
}

export interface DocumentResult {
  file: string | null;
  word_count: number;
  errors: WordError[];
}

export interface Detection {
  language: string | null;
  confidence: number;
}

export interface Health {
  status: string;
  ready: Record<string, boolean>;
  timestamp?: string;
}

export interface ClientOptions {
  language?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export class KotoshuError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "KotoshuError";
  }
}

export class ResourceNotSetupError extends KotoshuError {
  constructor(message: string) {
    super(message, "resource_not_setup");
    this.name = "ResourceNotSetupError";
  }
}

export class Client {
  private readonly baseUrl: string;
  private readonly defaultLanguage: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(baseUrl = "http://localhost:9292", options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.defaultLanguage = options.language ?? "en";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = { "Content-Type": "application/json", ...options.headers };
  }

  health(): Promise<Health> {
    return this.get<Health>("/v1/health");
  }

  async languages(): Promise<string[]> {
    const resp = await this.get<{ cached: string[] }>("/v1/languages");
    return resp.cached ?? [];
  }

  async check(text: string, language?: string, fmt: "full" | "errors" = "full"): Promise<DocumentResult> {
    return this.post<DocumentResult>("/v1/check", {
      text,
      language: language ?? this.defaultLanguage,
      format: fmt,
    });
  }

  async suggest(word: string, options: { language?: string; max?: number } = {}): Promise<Suggestion[]> {
    const body: Record<string, unknown> = {
      word,
      language: options.language ?? this.defaultLanguage,
    };
    if (options.max !== undefined) body.max = options.max;
    const resp = await this.post<{ suggestions: Suggestion[] }>("/v1/suggest", body);
    return resp.suggestions ?? [];
  }

  detect(text: string): Promise<Detection> {
    return this.post<Detection>("/v1/detect", { text });
  }

  async correct(word: string, language?: string): Promise<boolean> {
    const result = await this.check(word, language);
    return result.errors.length === 0;
  }

  // ---- Internals ----

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: this.headers,
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const resp = await this.fetchImpl(this.baseUrl + path, init);
      const text = await resp.text();
      let data: unknown = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw new KotoshuError(
          `non-JSON response from server (status=${resp.status}): ${text.slice(0, 200)}`,
        );
      }
      if (resp.ok) return data as T;
      const errObj = (data ?? {}) as Record<string, string>;
      const code = errObj.error ?? "http_error";
      const msg = errObj.message ?? text;
      if (code === "resource_not_setup") throw new ResourceNotSetupError(msg);
      throw new KotoshuError(`${code}: ${msg}`, code);
    } finally {
      clearTimeout(timer);
    }
  }
}

export default Client;
