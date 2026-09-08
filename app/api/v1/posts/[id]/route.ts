import { NextResponse } from "next/server";

import { getPublication } from "@/lib/mock-store";
import type { ApiErrorEnvelope } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const publication = getPublication(id);

  if (!publication) {
    const body: ApiErrorEnvelope = {
      error: {
        code: "NOT_FOUND",
        message: "No existe una publicación con ese identificador.",
        requestId: `req_${Math.random().toString(36).slice(2, 12)}`,
      },
    };
    return NextResponse.json(body, { status: 404 });
  }

  return NextResponse.json({
    data: publication,
    meta: {
      requestId: `req_${Math.random().toString(36).slice(2, 12)}`,
      pollUrl: `/api/v1/posts/${publication.id}`,
    },
  });
}
