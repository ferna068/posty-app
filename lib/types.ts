/**
 * Tipos del contrato de publicación de Posty.
 * Alineados con ARCHITECTURE.md §4 (POST /api/v1/posts/publish) y §5 (modelo de errores).
 */

export type NetworkId = "twitter" | "linkedin" | "facebook";

export type PublicationStatus =
  | "queued"
  | "processing"
  | "completed"
  | "partial"
  | "failed";

export type TargetStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "skipped";

/** Códigos de error a nivel target (ARCHITECTURE.md §5.2). */
export type TargetErrorCode =
  | "REAUTH_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "DUPLICATE_CONTENT"
  | "CONTENT_REJECTED"
  | "RATE_LIMITED"
  | "TEXT_TOO_LONG"
  | "NETWORK_NOT_CONNECTED"
  | "INTERNAL_ERROR";

export interface TargetError {
  code: TargetErrorCode;
  message: string;
  retryable: boolean;
  providerStatus?: number;
  reconnectUrl?: string;
}

export interface PublicationTarget {
  network: NetworkId;
  connectionId: string;
  accountName: string;
  status: TargetStatus;
  externalPostId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  error: TargetError | null;
}

export interface Publication {
  id: string;
  status: PublicationStatus;
  text: string;
  scheduledAt: string | null;
  createdAt: string;
  completedAt: string | null;
  targets: PublicationTarget[];
}

/** Respuesta 202 / 200 del endpoint de publicación. */
export interface PublicationEnvelope {
  data: Publication;
  meta: {
    requestId: string;
    pollUrl: string;
  };
}

/** Formato único de error (ARCHITECTURE.md §5.1). */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Array<Record<string, unknown>>;
    docs?: string;
  };
}

export interface PublishRequestBody {
  text: string;
  networks: NetworkId[];
  options?: {
    validateOnly?: boolean;
    allowPartialSuccess?: boolean;
  };
}
