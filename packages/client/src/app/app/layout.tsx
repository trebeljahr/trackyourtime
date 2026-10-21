import type { Metadata } from "next";
import { ProtectedLayout } from "@/components/protected-layout";

export const metadata: Metadata = { robots: { index: false } };

export default function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ProtectedLayout>{children}</ProtectedLayout>;
}
