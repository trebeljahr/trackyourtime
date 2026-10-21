import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false } };

export default function Layout({ children }: { children: React.ReactNode }): React.ReactNode {
  return children;
}
