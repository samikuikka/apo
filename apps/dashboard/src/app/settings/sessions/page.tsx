"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { signOutEverywhere } from "@/lib/users-api";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { MonitorSmartphone } from "lucide-react";

export default function SessionsSettingsPage() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOutEverywhere() {
    setSigningOut(true);
    try {
      await signOutEverywhere();
      signOut({ callbackUrl: "/login" });
    } catch (e) {
      setSigningOut(false);
      setConfirmOpen(false);
      toast.error(e instanceof Error ? e.message : "Failed to sign out everywhere");
    }
  }

  return (
    <>
      <SettingsPageHeader
        title="Sessions"
        description="Revoke your active sign-ins across all devices and browsers."
        icon={MonitorSmartphone}
      />

      <div className="mx-auto max-w-2xl px-6 py-8">
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold mb-1">Sign out everywhere</h2>
          <p className="text-[12px] text-muted-foreground mb-4">
            Revoke all active sessions on every device and browser. You will need to sign in again.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
            Sign out all devices
          </Button>
        </section>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Sign out all devices</DialogTitle>
            <DialogDescription>
              This will sign you out from all devices and browsers. You will need to sign in again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSignOutEverywhere} disabled={signingOut}>
              {signingOut ? "Signing out..." : "Sign out everywhere"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
