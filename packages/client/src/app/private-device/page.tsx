import type { Metadata } from "next";
import { PrivateDeviceApproval } from "@/components/device/private-device-approval";
export const metadata: Metadata = { title: "Approve private data access", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function PrivateDevicePage() { return <PrivateDeviceApproval />; }
