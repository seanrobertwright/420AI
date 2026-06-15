import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "420AI — Live Monitor",
  description: "Real-time observability over collectors, connectors, and active sessions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
