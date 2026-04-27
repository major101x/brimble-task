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
  // TanStack Query handles the polling interval, deduplication,
  // and cache invalidation for us.
  const { data: deployments = [], isLoading } = useQuery({
    queryKey: ["deployments"],
    queryFn: fetchDeployments,
    refetchInterval: 3000,
  });

  const mutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: () => {
      // Immediately invalidate the deployments cache so the new
      // deployment appears in the list without waiting for the next poll.
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      setName("");
      setSource("");
    },
  });

  // This effect manages the SSE connection for the active log stream.
  // It runs whenever activeLogId changes — opening a new EventSource
  // when the user selects a deployment, and closing the previous one
  // to prevent memory leaks and stale connections.
  useEffect(() => {
    if (!activeLogId) return;

    const es = new EventSource(`${API}/deployments/${activeLogId}/logs`);

    es.onmessage = (event) => {
      const { line } = JSON.parse(event.data);
      setLogs((prev) => ({
        ...prev,
        // We append to the existing lines for this deployment ID
        // rather than replacing them, so scrolling back through
        // earlier output still works after new lines arrive.
        [activeLogId]: [...(prev[activeLogId] ?? []), line],
      }));
    };

    es.onerror = () => {
      // The EventSource will attempt to reconnect automatically on error.
      // We don't need to handle reconnection manually — that's one of the
      // main advantages of SSE over raw WebSockets for this use case.
      es.close();
    };

    // The cleanup function returned from useEffect runs when the component
    // unmounts OR when activeLogId changes before the next render.
    // This is what prevents multiple simultaneous EventSource connections.
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

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "2rem",
        fontFamily: "monospace",
      }}
    >
      <h1>Brimble Task — Deployment Pipeline</h1>

      {/* Deployment form */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>New Deployment</h2>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            marginTop: "0.5rem",
          }}
        >
          <input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ padding: "0.5rem", flex: 1 }}
          />
          <input
            placeholder="Git URL or local path"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ padding: "0.5rem", flex: 2 }}
          />
          <button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            style={{ padding: "0.5rem 1rem" }}
          >
            {mutation.isPending ? "Deploying..." : "Deploy"}
          </button>
        </div>
        {mutation.isError && (
          <p style={{ color: "red" }}>{(mutation.error as Error).message}</p>
        )}
      </section>

      {/* Deployments list */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Deployments</h2>
        {isLoading && <p>Loading...</p>}
        {deployments.length === 0 && !isLoading && <p>No deployments yet.</p>}
        {deployments.map((d) => (
          <div
            key={d.id}
            style={{
              border: "1px solid #ccc",
              padding: "1rem",
              marginTop: "0.5rem",
              borderLeft: `4px solid ${statusColor(d.status)}`,
            }}
          >
            <strong>{d.name}</strong>
            <span style={{ marginLeft: "1rem", color: statusColor(d.status) }}>
              {d.status}
            </span>
            {d.image_tag && (
              <span style={{ marginLeft: "1rem", color: "#666" }}>
                image: {d.image_tag}
              </span>
            )}
            {d.url && (
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                style={{ marginLeft: "1rem" }}
              >
                open →
              </a>
            )}
            <div
              style={{
                fontSize: "0.8rem",
                color: "#999",
                marginTop: "0.25rem",
              }}
            >
              {d.id} · {new Date(d.created_at).toLocaleString()}
            </div>
            <button
              onClick={() => setActiveLogId(d.id)}
              style={{
                marginTop: "0.5rem",
                padding: "0.25rem 0.75rem",
                fontSize: "0.85rem",
              }}
            >
              View Logs
            </button>
          </div>
        ))}
      </section>

      {/* Log panel */}
      {activeLogId && (
        <section>
          <h2>
            Logs —{" "}
            {deployments.find((d) => d.id === activeLogId)?.name ?? activeLogId}
            <button
              onClick={() => setActiveLogId(null)}
              style={{ marginLeft: "1rem", fontSize: "0.8rem" }}
            >
              close
            </button>
          </h2>
          <div
            style={{
              background: "#111",
              color: "#eee",
              padding: "1rem",
              height: 400,
              overflowY: "scroll",
              marginTop: "0.5rem",
              fontSize: "0.85rem",
              lineHeight: 1.6,
            }}
          >
            {(logs[activeLogId] ?? []).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div ref={logEndRef} />
          </div>
        </section>
      )}
    </div>
  );
}

// Maps deployment status to a color for visual feedback.
// This is the only "design" decision in this file — everything else is functional.
function statusColor(status: Deployment["status"]): string {
  switch (status) {
    case "pending":
      return "#999";
    case "building":
      return "#f0a500";
    case "deploying":
      return "#2196f3";
    case "running":
      return "#4caf50";
    case "failed":
      return "#f44336";
  }
}
