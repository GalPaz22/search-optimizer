async function req(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? JSON.stringify(body.error) : `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  tenants: () => req("/api/tenants"),
  experiments: (params = "") => req(`/api/experiments${params}`),
  experiment: (id: string) => req(`/api/experiments/${id}`),
  metrics: (id: string) => req(`/api/experiments/${id}/metrics`),
  refreshMetrics: (id: string) => req(`/api/experiments/${id}/metrics/refresh`, { method: "POST" }),
  action: (id: string, action: string, body: Record<string, unknown> = {}) =>
    req(`/api/experiments/${id}/${action}`, { method: "POST", body: JSON.stringify(body) }),
  proposals: (status = "pending") => req(`/api/proposals?status=${status}`),
  approveProposal: (id: string, start: boolean) =>
    req(`/api/proposals/${id}/approve`, { method: "POST", body: JSON.stringify({ by: "ops", start }) }),
  rejectProposal: (id: string, note: string) =>
    req(`/api/proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ by: "ops", note }) }),
  runAgent: (tenant: string) => req(`/api/agent/run?tenant=${encodeURIComponent(tenant)}`, { method: "POST" }),
  agentRuns: () => req("/api/agent/runs"),
  agentSpend: (tenant: string) => req(`/api/agent/spend?tenant=${encodeURIComponent(tenant)}`),
  createExperiment: (body: unknown) =>
    req("/api/experiments?status=approved", { method: "POST", body: JSON.stringify(body) }),
  parseRule: (tenantApiKey: string, text: string) =>
    req("/api/rules/parse", { method: "POST", body: JSON.stringify({ tenantApiKey, text }) }),
  rules: (tenant?: string) => req(`/api/rules${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`),
  createRule: (body: unknown) => req("/api/rules", { method: "POST", body: JSON.stringify(body) }),
  ruleAction: (id: string, action: "enable" | "disable") =>
    req(`/api/rules/${id}/${action}`, { method: "POST" }),
  deleteRule: (id: string) => req(`/api/rules/${id}`, { method: "DELETE" }),
};
