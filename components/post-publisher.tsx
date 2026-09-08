"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";

import { NETWORKS } from "@/lib/networks";
import type {
  ApiErrorEnvelope,
  NetworkId,
  Publication,
  PublicationEnvelope,
  PublicationTarget,
} from "@/lib/types";
import { NetworkGlyph } from "./network-glyph";

const EXAMPLE_TEXT =
  "El desarrollo de software ya no es un reto de escribir código, sino de decidir qué construir. Las herramientas cambian; el criterio, no.";

const POLL_INTERVAL_MS = 1200;
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

type Phase = "idle" | "submitting" | "publishing" | "done";

interface FieldError {
  code: string;
  message: string;
  requestId: string;
  details?: Array<Record<string, unknown>>;
}

export function PostPublisher() {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<NetworkId>>(
    () => new Set<NetworkId>(["twitter", "linkedin", "facebook"]),
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [publication, setPublication] = useState<Publication | null>(null);
  const [error, setError] = useState<FieldError | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const trimmedLength = text.trim().length;
  const busy = phase === "submitting" || phase === "publishing";
  const canSubmit = trimmedLength > 0 && selected.size > 0 && !busy;

  const toggleNetwork = (id: NetworkId) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const poll = useCallback(
    (pollUrl: string) => {
      abortRef.current = new AbortController();
      fetch(pollUrl, { signal: abortRef.current.signal, cache: "no-store" })
        .then((res) => res.json())
        .then((body: PublicationEnvelope) => {
          setPublication(body.data);
          if (TERMINAL_STATUSES.has(body.data.status)) {
            setPhase("done");
            stopPolling();
          } else {
            pollTimer.current = setTimeout(() => poll(pollUrl), POLL_INTERVAL_MS);
          }
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setError({
            code: "NETWORK_ERROR",
            message: "Se perdió la conexión mientras se comprobaba el estado.",
            requestId: "-",
          });
          setPhase("done");
          stopPolling();
        });
    },
    [stopPolling],
  );

  const publish = useCallback(
    async (networks: NetworkId[]) => {
      stopPolling();
      setError(null);
      setPublication(null);
      setPhase("submitting");

      try {
        const res = await fetch("/api/v1/posts/publish", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ text: text.trim(), networks }),
        });

        const body = (await res.json()) as
          | PublicationEnvelope
          | ApiErrorEnvelope;

        if (!res.ok || "error" in body) {
          const e = (body as ApiErrorEnvelope).error;
          setError(e);
          setPhase("idle");
          return;
        }

        setPublication(body.data);
        setPhase("publishing");
        poll(body.meta.pollUrl);
      } catch {
        setError({
          code: "NETWORK_ERROR",
          message: "No se pudo contactar con el servidor. Inténtalo de nuevo.",
          requestId: "-",
        });
        setPhase("idle");
      }
    },
    [text, poll, stopPolling],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    void publish([...selected]);
  };

  const reset = () => {
    stopPolling();
    setPhase("idle");
    setPublication(null);
    setError(null);
  };

  const failedRetryable = useMemo(
    () =>
      (publication?.targets ?? []).filter(
        (t) => t.status === "failed" && t.error?.retryable,
      ),
    [publication],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {/* Mensaje ---------------------------------------------------------- */}
      <label htmlFor="post-text" className="sr-only">
        Mensaje a publicar
      </label>
      <textarea
        id="post-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        rows={5}
        placeholder={`Ej: ${EXAMPLE_TEXT}`}
        className="w-full resize-y rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm leading-relaxed outline-none transition placeholder:text-neutral-400 focus:border-neutral-400 focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-white/10"
      />

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        {!text && (
          <button
            type="button"
            onClick={() => setText(EXAMPLE_TEXT)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Sparkles className="h-3.5 w-3.5" /> Usar texto de ejemplo
          </button>
        )}
        {[...selected].map((id) => {
          const net = NETWORKS.find((n) => n.id === id)!;
          const over = trimmedLength > net.maxTextLength;
          return (
            <span
              key={id}
              className={over ? "font-semibold text-red-600 dark:text-red-400" : ""}
            >
              {net.label} {trimmedLength}/{net.maxTextLength}
            </span>
          );
        })}
      </div>

      {/* Selector de redes --------------------------------------------------- */}
      <fieldset className="mt-4" disabled={busy}>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Publicar en
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {NETWORKS.map((net) => {
            const checked = selected.has(net.id);
            return (
              <label
                key={net.id}
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 text-sm transition select-none ${
                  checked
                    ? `${net.accent.border} bg-neutral-50 ring-2 ${net.accent.ring} dark:bg-neutral-800/50`
                    : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600"
                } ${busy ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={checked}
                  onChange={() => toggleNetwork(net.id)}
                />
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
                    checked
                      ? `${net.accent.bg} ${net.accent.border} text-white dark:text-neutral-900`
                      : "border-neutral-300 dark:border-neutral-600"
                  }`}
                >
                  {checked && (
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
                      <path
                        d="M2.5 6.2 5 8.5 9.5 3.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <NetworkGlyph
                  network={net.id}
                  className={`h-4 w-4 ${checked ? net.accent.text : "text-neutral-400"}`}
                />
                <span className="font-medium">{net.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Error de formulario / API ----------------------------------------- */}
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">{error.message}</p>
          <p className="mt-0.5 text-xs opacity-70">
            {error.code}
            {error.requestId !== "-" && ` · ${error.requestId}`}
          </p>
          {!!error.details?.length && (
            <ul className="mt-1.5 list-inside list-disc text-xs">
              {error.details.map((d, i) => (
                <li key={i}>
                  {[d.network, d.field].filter(Boolean).join(" ")} — {String(d.code)}
                  {d.limit != null && ` (límite ${String(d.limit)}, actual ${String(d.actual)})`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Resultado por red ------------------------------------------------- */}
      {publication && (
        <div className="mt-4 space-y-2">
          <StatusBanner status={publication.status} phase={phase} />
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {publication.targets.map((target) => (
              <TargetRow key={target.network} target={target} />
            ))}
          </ul>
        </div>
      )}

      {/* Acciones -------------------------------------------------------- */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {phase === "done" ? (
          <>
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Nueva publicación
            </button>
            {failedRetryable.length > 0 && (
              <button
                type="button"
                onClick={() => publish(failedRetryable.map((t) => t.network))}
                className="inline-flex items-center gap-2 rounded-xl border border-neutral-300 px-4 py-2.5 text-sm font-semibold transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                <RefreshCw className="h-4 w-4" />
                Reintentar {failedRetryable.length} red
                {failedRetryable.length > 1 ? "es" : ""}
              </button>
            )}
          </>
        ) : (
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {busy ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {phase === "submitting" ? "Enviando…" : "Publicando…"}
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Publicar Ahora
              </>
            )}
          </button>
        )}
        {selected.size === 0 && phase === "idle" && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Selecciona al menos una red.
          </span>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function StatusBanner({
  status,
  phase,
}: {
  status: Publication["status"];
  phase: Phase;
}) {
  if (phase !== "done") {
    return (
      <p className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Publicando en {status === "queued" ? "cola" : "curso"}…
      </p>
    );
  }
  const map = {
    completed: {
      cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
      label: "Publicado en todas las redes seleccionadas.",
    },
    partial: {
      cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
      label: "Publicado parcialmente. Algunas redes fallaron.",
    },
    failed: {
      cls: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300",
      label: "No se pudo publicar en ninguna red.",
    },
    queued: { cls: "", label: "" },
    processing: { cls: "", label: "" },
  } as const;
  const entry = map[status];
  if (!entry.label) return null;
  return (
    <p className={`rounded-xl border px-3 py-2 text-sm font-medium ${entry.cls}`}>
      {entry.label}
    </p>
  );
}

function TargetRow({ target }: { target: PublicationTarget }) {
  const net = NETWORKS.find((n) => n.id === target.network)!;

  return (
    <li className="flex items-start gap-3 bg-white p-3 dark:bg-neutral-900">
      <NetworkGlyph network={net.id} className={`mt-0.5 h-4 w-4 ${net.accent.text}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{net.label}</span>
          <span className="truncate text-xs text-neutral-400">{target.accountName}</span>
        </div>

        {(target.status === "pending" || target.status === "processing") && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Publicando…
          </p>
        )}

        {target.status === "published" && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CircleCheck className="h-3.5 w-3.5" />
            Publicado
            {target.permalink && (
              <a
                href={target.permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
              >
                Ver publicación <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        )}

        {target.status === "failed" && target.error && (
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <CircleAlert className="h-3.5 w-3.5 shrink-0" />
            <span>{target.error.message}</span>
            {target.error.reconnectUrl && (
              <a
                href={target.error.reconnectUrl}
                className="font-medium underline underline-offset-2"
              >
                Reconectar
              </a>
            )}
            {target.error.retryable && (
              <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                se reintentará
              </span>
            )}
          </p>
        )}

        {target.status === "skipped" && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <CircleSlash className="h-3.5 w-3.5" />
            {target.error?.message ?? "Omitida."}
          </p>
        )}
      </div>
    </li>
  );
}
