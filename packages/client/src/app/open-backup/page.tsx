import Link from "next/link";
import { OpenRecoveryBackup } from "@/components/data/open-recovery-backup";
export const metadata = { title: "Open a local backup" };
export default function OpenBackupPage(): React.JSX.Element {
  return <main className="px-6 py-12"><div className="mx-auto max-w-xl space-y-6">
    <Link href="/login" className="text-sm font-medium underline underline-offset-4">Track Your Time</Link>
    <OpenRecoveryBackup standalone />
  </div></main>;
}
