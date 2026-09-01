import type { Metadata } from "next";

import { AdminPanel } from "@/components/admin-panel";

export const metadata: Metadata = {
  title: "Operator · Cachet",
  robots: { index: false, follow: false },
};

/** Operator moderation page. Useless without the instance's admin token:
 *  the API answers 404 to everything unless CACHET_ADMIN_TOKEN is set and
 *  presented. Nothing here is secret — it is a remote control, not a door. */
export default function AdminPage() {
  return <AdminPanel />;
}
