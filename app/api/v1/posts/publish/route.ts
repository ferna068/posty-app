import { NextResponse } from "next/server";

import { createPublication } from "@/lib/mock-store";
import { NETWORKS_BY_ID } from "@/lib/networks";
import type { ApiErrorEnvelope, NetworkId, PublicationEnvelope } from "@/lib/types";

export const runtime = "nodejs";

const VALID_NETWORKS: NetworkId[] = ["twitter", "linkedin", "facebook"];
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 63206;

function requestId(): string {
  return `req_${Math.random().toString(36).slice(2, 12)}`;
}

function error(
  status: number,
  code: string,
  message: string,
  details?: Array<Record<string, unknown>>,
): NextResponse<ApiErrorEnvelope> {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        requestId: requestId(),
        ...(details ? { details } : {}),
        docs: `https://docs.posty.app/errors/${code}`,
      },
    },
    { status },
  );
}

export async function POST(req: Request) {
  const reqId = requestId();

  // §4.4.2 — Idempotency-Key obligatoria (UUID v4).
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey || !UUID_V4.test(idempotencyKey)) {
    return error(
      400,
      "MISSING_IDEMPOTENCY_KEY",
      "Falta el header 'Idempotency-Key' o no es un UUID v4 válido.",
    );
  }

  // §4.4.3 — cuerpo JSON parseable.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "VALIDATION_ERROR", "El cuerpo de la petición no es JSON válido.");
  }

  const { text, networks, options } = (body ?? {}) as {
    text?: unknown;
    networks?: unknown;
    options?: { validateOnly?: unknown; allowPartialSuccess?: unknown };
  };

  const details: Array<Record<string, unknown>> = [];
  if (typeof text !== "string" || text.trim().length === 0) {
    details.push({ field: "text", code: "REQUIRED", message: "text must not be empty" });
  } else if (text.length > MAX_TEXT) {
    details.push({ field: "text", code: "TOO_LONG", limit: MAX_TEXT, actual: text.length });
  }

  if (!Array.isArray(networks) || networks.length === 0) {
    details.push({
      field: "networks",
      code: "REQUIRED",
      message: "at least one network is required",
    });
  } else {
    if (networks.length > 3) {
      details.push({ field: "networks", code: "TOO_MANY", max: 3 });
    }
    if (new Set(networks).size !== networks.length) {
      details.push({ field: "networks", code: "DUPLICATES" });
    }
    if (networks.some((n) => !VALID_NETWORKS.includes(n as NetworkId))) {
      details.push({
        field: "networks",
        code: "UNKNOWN_NETWORK",
        allowed: VALID_NETWORKS,
      });
    }
  }

  if (details.length > 0) {
    return error(422, "VALIDATION_ERROR", "El cuerpo no cumple el esquema.", details);
  }

  const cleanText = (text as string).trim();
  const requested = networks as NetworkId[];
  const allowPartialSuccess = options?.allowPartialSuccess !== false;

  // §4.4.7 — longitud del texto por red destino.
  const tooLong = requested.filter(
    (n) => cleanText.length > NETWORKS_BY_ID[n].maxTextLength,
  );
  const publishable = requested.filter(
    (n) => cleanText.length <= NETWORKS_BY_ID[n].maxTextLength,
  );

  // §4.4.8 — sin targets publicables, o partial no permitido.
  if (publishable.length === 0 || (!allowPartialSuccess && tooLong.length > 0)) {
    return error(
      422,
      "NO_PUBLISHABLE_TARGET",
      "Ninguna de las redes solicitadas puede publicar este texto.",
      tooLong.map((n) => ({
        network: n,
        code: "TEXT_TOO_LONG",
        limit: NETWORKS_BY_ID[n].maxTextLength,
        actual: cleanText.length,
      })),
    );
  }

  // §4.4.9 — validateOnly: 200, sin persistir.
  if (options?.validateOnly === true) {
    return NextResponse.json({
      data: {
        resolved: publishable,
        skipped: tooLong.map((n) => ({
          network: n,
          code: "TEXT_TOO_LONG",
          limit: NETWORKS_BY_ID[n].maxTextLength,
          actual: cleanText.length,
        })),
      },
      meta: { requestId: reqId },
    });
  }

  const publication = createPublication(cleanText, publishable);

  // Targets descartados por longitud se exponen como `skipped` con su error.
  for (const n of tooLong) {
    publication.targets.push({
      network: n,
      connectionId: `cln_skipped_${n}`,
      accountName: NETWORKS_BY_ID[n].accountName,
      status: "skipped",
      externalPostId: null,
      permalink: null,
      publishedAt: null,
      error: {
        code: "TEXT_TOO_LONG",
        message: `El texto supera el límite de ${NETWORKS_BY_ID[n].maxTextLength} caracteres de ${NETWORKS_BY_ID[n].label}.`,
        retryable: false,
      },
    });
  }

  const envelope: PublicationEnvelope = {
    data: publication,
    meta: { requestId: reqId, pollUrl: `/api/v1/posts/${publication.id}` },
  };

  return NextResponse.json(envelope, {
    status: 202,
    headers: {
      Location: `/api/v1/posts/${publication.id}`,
      "X-Request-Id": reqId,
    },
  });
}
