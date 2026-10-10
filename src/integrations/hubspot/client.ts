/**
 * HubSpot CRM v3 over fetch, authenticated with a service key (Bearer token).
 * https://developers.hubspot.com/docs/api-reference/crm
 */
const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  constructor(
    public readonly status: number,
    public readonly category: string | null,
    message: string,
    public readonly missingScopes: string[] = [],
  ) {
    super(message);
    this.name = "HubSpotError";
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: { id: string; label: string; displayOrder: number; metadata: { probability?: string; isClosed?: string } }[];
}

export interface HubSpotClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  searchOne(objectType: "contacts" | "deals", property: string, value: string, properties: string[]): Promise<HubSpotObject | null>;
  create(objectType: "contacts" | "deals", properties: Record<string, unknown>, associations?: unknown[]): Promise<HubSpotObject>;
  update(objectType: "contacts" | "deals", id: string, properties: Record<string, unknown>): Promise<HubSpotObject>;
  get(objectType: "contacts" | "deals", id: string, properties: string[]): Promise<HubSpotObject | null>;
  pipelines(): Promise<HubSpotPipeline[]>;
  owners(): Promise<{ id: string; email: string; firstName: string; lastName: string }[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function hubspotClient(serviceKey: string, fetchImpl: typeof fetch = fetch, opts: { maxRetries?: number; backoffMs?: number } = {}): HubSpotClient {
  const maxRetries = opts.maxRetries ?? 3;
  const backoff = opts.backoffMs ?? 500;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Only reads/searches/PATCH are retried in-process; creates are retried by the job queue,
    // which searches for the object again first so a retry can't duplicate it.
    const retrySafe = method === "GET" || method === "PATCH" || path.endsWith("/search");
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 204) return undefined as T;
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return json as T;
      const err = toError(res.status, json);
      if (retrySafe && err.retryable && attempt < maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  return {
    request,
    async searchOne(objectType, property, value, properties) {
      const r = await request<{ results: HubSpotObject[] }>("POST", `/crm/v3/objects/${objectType}/search`, {
        filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
        properties,
        limit: 1,
      });
      return r.results[0] ?? null;
    },
    create(objectType, properties, associations) {
      return request<HubSpotObject>("POST", `/crm/v3/objects/${objectType}`, { properties, ...(associations ? { associations } : {}) });
    },
    update(objectType, id, properties) {
      return request<HubSpotObject>("PATCH", `/crm/v3/objects/${objectType}/${id}`, { properties });
    },
    async get(objectType, id, properties) {
      try {
        return await request<HubSpotObject>("GET", `/crm/v3/objects/${objectType}/${id}?properties=${properties.join(",")}`);
      } catch (e) {
        if (e instanceof HubSpotError && e.status === 404) return null;
        throw e;
      }
    },
    async pipelines() {
      const r = await request<{ results: HubSpotPipeline[] }>("GET", "/crm/v3/pipelines/deals");
      return r.results;
    },
    async owners() {
      const r = await request<{ results: { id: string; email: string; firstName: string; lastName: string }[] }>("GET", "/crm/v3/owners?limit=100&archived=false");
      return r.results;
    },
  };
}

function toError(status: number, json: Record<string, unknown>): HubSpotError {
  const category = typeof json.category === "string" ? json.category : null;
  const message = typeof json.message === "string" ? json.message : `HubSpot HTTP ${status}`;
  const scopes = new Set<string>();
  const errors = Array.isArray(json.errors) ? (json.errors as { context?: Record<string, unknown> }[]) : [];
  for (const e of errors) {
    for (const key of ["requiredGranularScopes", "requiredScopes", "requiredGranularScopeSets"]) {
      const v = e.context?.[key];
      if (Array.isArray(v)) v.flat().forEach((s) => typeof s === "string" && scopes.add(s));
    }
  }
  return new HubSpotError(status, category, message.slice(0, 300), [...scopes]);
}
