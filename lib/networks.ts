import type { NetworkId } from "./types";

export interface NetworkMeta {
  id: NetworkId;
  /** Etiqueta visible (marca comercial). */
  label: string;
  /** Handle / cuenta simulada que quedará asociada al target. */
  accountName: string;
  /** Límite de caracteres del proveedor (ARCHITECTURE.md §2.6). */
  maxTextLength: number;
  /** Clases Tailwind para el color de marca. */
  accent: {
    text: string;
    bg: string;
    ring: string;
    border: string;
  };
}

export const NETWORKS: NetworkMeta[] = [
  {
    id: "twitter",
    label: "X",
    accountName: "@posty_app",
    maxTextLength: 280,
    accent: {
      text: "text-neutral-900 dark:text-neutral-100",
      bg: "bg-neutral-900 dark:bg-neutral-100",
      ring: "ring-neutral-900/20 dark:ring-neutral-100/20",
      border: "border-neutral-900 dark:border-neutral-100",
    },
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    accountName: "Emanuel Fernández",
    maxTextLength: 3000,
    accent: {
      text: "text-[#0a66c2]",
      bg: "bg-[#0a66c2]",
      ring: "ring-[#0a66c2]/25",
      border: "border-[#0a66c2]",
    },
  },
  {
    id: "facebook",
    label: "Facebook",
    accountName: "Posty HQ",
    maxTextLength: 63206,
    accent: {
      text: "text-[#1877f2]",
      bg: "bg-[#1877f2]",
      ring: "ring-[#1877f2]/25",
      border: "border-[#1877f2]",
    },
  },
];

export const NETWORKS_BY_ID: Record<NetworkId, NetworkMeta> = Object.fromEntries(
  NETWORKS.map((n) => [n.id, n]),
) as Record<NetworkId, NetworkMeta>;
