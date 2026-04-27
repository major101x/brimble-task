import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// This type mirrors the Deployment interface in our backend exactly.
// Keeping them in sync manually is fine for this scope — in a larger
// project you'd share types via a monorepo or generate them from an OpenAPI spec.
interface Deployment {
  id: string;
  name: string;
  source: string;
  status: "pending" | "building" | "deploying" | "running" | "failed";
  image_tag: string | null;
  url: string | null;
  created_at: string;
}

// All API calls go through /api — Caddy proxies this to the backend.
// We never hardcode the backend port in the frontend, which means this
// works identically in local Docker Compose and in any deployed environment.
const API = "/api";

async function fetchDeployments(): Promise<Deployment[]> {
  const res = await fetch(`${API}/deployments`);
  if (!res.ok) throw new Error("Failed to fetch deployments");
  return res.json();
}

async function createDeployment(data: {
  name: string;
  source: string;
}): Promise<Deployment> {
  const res = await fetch(`${API}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to create deployment");
  return res.json();
}

export default function App() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [activeLogId, setActiveLogId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const logEndRef = useRef<HTMLDivElement>(null);

  // Poll for deployments every 3 seconds so status updates appear
  // automatically without the user having to refresh.
  const { data: deployments = [], isLoading } = useQuery({
    queryKey: ["deployments"],
    queryFn: fetchDeployments,
    refetchInterval: 3000,
  });

  const mutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      setName("");
      setSource("");
    },
  });

  // Manages the SSE connection for the active log stream.
  // Opens a new EventSource when the user selects a deployment,
  // and closes the previous one to prevent memory leaks.
  useEffect(() => {
    if (!activeLogId) return;

    const es = new EventSource(`${API}/deployments/${activeLogId}/logs`);

    es.onmessage = (event) => {
      const { line } = JSON.parse(event.data);
      setLogs((prev) => ({
        ...prev,
        [activeLogId]: [...(prev[activeLogId] ?? []), line],
      }));
    };

    es.onerror = () => {
      es.close();
    };

    return () => es.close();
  }, [activeLogId]);

  // Auto-scroll the log panel to the bottom whenever new lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, activeLogId]);

  function handleSubmit() {
    if (!name.trim() || !source.trim()) return;
    mutation.mutate({ name, source });
  }

  const activeDeploymentName =
    deployments.find((d) => d.id === activeLogId)?.name ?? activeLogId;

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-logo" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
        <div>
          <div className="app-title">Brimble Task</div>
          <div className="app-subtitle">deployment pipeline</div>
        </div>
      </header>

      {/* New Deployment form */}
      <section className="section">
        <p className="section-title">New Deployment</p>
        <form
          className="deploy-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="form-field">
            <label className="form-label" htmlFor="deploy-name">
              Name
            </label>
            <input
              id="deploy-name"
              className="form-input"
              placeholder="my-app"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-field form-field--wide">
            <label className="form-label" htmlFor="deploy-source">
              Source
            </label>
            <input
              id="deploy-source"
              className="form-input"
              placeholder="https://github.com/org/repo"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn-deploy"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Deploying…" : "Deploy"}
          </button>
        </form>
        {mutation.isError && (
          <p className="form-error">{(mutation.error as Error).message}</p>
        )}
      </section>

      {/* Deployments list */}
      <section className="section">
        <p className="section-title">Deployments</p>
        <div className="deployments-list">
          {isLoading && (
            <div className="deployment-loading">Loading…</div>
          )}
          {!isLoading && deployments.length === 0 && (
            <div className="deployment-empty">
              No deployments yet. Push your first one above.
            </div>
          )}
          {deployments.map((d) => (
            <div key={d.id} className="deployment-card">
              <div className="deployment-card-top">
                <span className="deployment-name">{d.name}</span>
                <span className={`status-badge status-badge--${d.status}`}>
                  {d.status}
                </span>
                {d.image_tag && (
                  <span className="deployment-image-tag">{d.image_tag}</span>
                )}
                {d.url && (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="deployment-url"
                    aria-label={`Open ${d.name}`}
                  >
                    open ↗
                  </a>
                )}
              </div>
              <div className="deployment-card-bottom">
                <span className="deployment-meta">
                  <span>{d.id}</span>
                  <span className="deployment-meta-sep">·</span>
                  <span>{new Date(d.created_at).toLocaleString()}</span>
                </span>
                <button
                  className="btn-logs"
                  onClick={() => setActiveLogId(d.id)}
                  aria-label={`View logs for ${d.name}`}
                >
                  View Logs
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Log terminal panel */}
      {activeLogId && (
        <section className="section log-panel">
          <div className="log-panel-header">
            <div className="log-panel-title">
              <div className="log-panel-dots" aria-hidden="true">
                <span className="log-dot log-dot--red" />
                <span className="log-dot log-dot--yellow" />
                <span className="log-dot log-dot--green" />
              </div>
              <span className="log-panel-name">
                logs — {activeDeploymentName}
              </span>
            </div>
            <button
              className="btn-close-logs"
              onClick={() => setActiveLogId(null)}
              aria-label="Close log panel"
            >
              close
            </button>
          </div>
          <div
            className="log-terminal"
            role="log"
            aria-live="polite"
            aria-label="Deployment logs"
          >
            {(logs[activeLogId] ?? []).length === 0 && (
              <span className="log-empty">Waiting for logs…</span>
            )}
            {(logs[activeLogId] ?? []).map((line, i) => (
              <div key={i} className="log-line">
                <span className="log-line-num">{i + 1}</span>
                <span className="log-line-text">{line}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </section>
      )}
    </div>
  );
}
