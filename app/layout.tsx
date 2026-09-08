import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Posty — Publicador multi-red",
  description:
    "Publica en X, LinkedIn y Facebook desde un solo sitio con seguimiento de estado por red.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="min-h-dvh text-neutral-900 antialiased dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
