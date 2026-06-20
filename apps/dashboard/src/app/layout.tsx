import type { Metadata } from "next";
import "./globals.css";
import { AppNav } from "@/components/app-nav";

export const metadata: Metadata = {
  title: "420AI — Dashboard",
  description: "Browse projects, reports, search, and machine health over the 420AI archive.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
