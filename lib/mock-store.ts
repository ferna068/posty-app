import { NETWORKS_BY_ID } from "./networks";
import type {
  NetworkId,
  Publication,
  PublicationTarget,
  PublicationStatus,
  TargetError,
} from "./types";

/**
 * Almacén en memoria que SIMULA el backend descrito en ARCHITECTURE.md §4.5:
 *
 *   POST  -> crea la Publication + N targets en `pending`, responde 202
 *   worker -> tras un pequeño delay, cada target pasa a `published` o `failed`
 *   GET   -> devuelve el estado actual (el cliente hace polling hasta estado terminal)
 *
 * No hay red social real detrás: el resultado por red se decide con un peso de
 * fallo por proveedor para que la UI muestre indicadores de éxito y de error.
 */

interface Store {
  publications: Map<string, Publication>;
}

const g = globalThis as unknown as { __postyStore?: Store };
const store: Store = g.__postyStore ?? { publications: new Map() };
g.__postyStore = store;

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

const FAILURE_WEIGHT: Record<NetworkId, number> = {
  twitter: 0.15,
  linkedin: 0.2,
  facebook: 0.45,
};

function simulatedError(network: NetworkId): TargetError {
  const pool: TargetError[] = [
    {
      code: "REAUTH_REQUIRED",
      message: `La conexión con ${NETWORKS_BY_ID[network].label} ha expirado. Vuelve a conectar la cuenta para publicar.`,
      retryable: false,
      providerStatus: 401,
      reconnectUrl: `/api/auth/${network}/connect`,
    },
    {
      code: "PROVIDER_UNAVAILABLE",
      message: `${NETWORKS_BY_ID[network].label} no respondió a tiempo. Se reintentará automáticamente.`,
      retryable: true,
      providerStatus: 503,
    },
    {
      code: "DUPLICATE_CONTENT",
      message: `${NETWORKS_BY_ID[network].label} rechazó el contenido por ser idéntico a una publicación reciente.`,
      retryable: false,
      providerStatus: 403,
    },
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function permalink(network: NetworkId, postId: string): string {
  switch (network) {
    case "twitter":
      return `https://x.com/posty_app/status/${postId}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/update/urn:li:share:${postId}`;
    case "facebook":
      return `https://www.facebook.com/${postId}`;
  }
}

function recomputeStatus(targets: PublicationTarget[]): PublicationStatus {
  const open = targets.some((t) => t.status === "pending" || t.status === "processing");
  if (open) return "processing";
  const published = targets.filter((t) => t.status === "published").length;
  const failed = targets.filter((t) => t.status === "failed").length;
  if (published > 0 && failed === 0) return "completed";
  if (published > 0 && failed > 0) return "partial";
  return "failed";
}

function scheduleResolution(publicationId: string): void {
  const pub = store.publications.get(publicationId);
  if (!pub) return;

  pub.targets.forEach((target, index) => {
    // Cada target es un "job" independiente con su propia latencia (§4.5).
    const delay = 900 + index * 500 + Math.random() * 1400;
    setTimeout(() => {
      const current = store.publications.get(publicationId);
      if (!current) return;
      const t = current.targets.find((x) => x.network === target.network);
      if (!t || t.status !== "pending") return;

      const failed = Math.random() < FAILURE_WEIGHT[t.network];
      if (failed) {
        t.status = "failed";
        t.error = simulatedError(t.network);
      } else {
        const postId = id("ext").replace(/[^0-9a-z]/gi, "").slice(0, 18);
        t.status = "published";
        t.externalPostId = postId;
        t.permalink = permalink(t.network, postId);
        t.publishedAt = new Date().toISOString();
      }

      current.status = recomputeStatus(current.targets);
      if (current.status !== "processing") {
        current.completedAt = new Date().toISOString();
      }
    }, delay);
  });
}

export function createPublication(text: string, networks: NetworkId[]): Publication {
  const now = new Date().toISOString();
  const publication: Publication = {
    id: id("pub"),
    status: "queued",
    text,
    scheduledAt: null,
    createdAt: now,
    completedAt: null,
    targets: networks.map((network) => ({
      network,
      connectionId: id("cln"),
      accountName: NETWORKS_BY_ID[network].accountName,
      status: "pending",
      externalPostId: null,
      permalink: null,
      publishedAt: null,
      error: null,
    })),
  };

  store.publications.set(publication.id, publication);
  scheduleResolution(publication.id);
  return publication;
}

export function getPublication(publicationId: string): Publication | undefined {
  return store.publications.get(publicationId);
}
