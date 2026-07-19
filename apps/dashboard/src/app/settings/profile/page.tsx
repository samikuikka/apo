"use client";

import { useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { backendFetch } from "@/lib/backend-fetch";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ProfileSettingsPage() {
  const { data: session } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [changing, setChanging] = useState(false);
  const signOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (signOutTimer.current) clearTimeout(signOutTimer.current);
    };
  }, []);

  async function handleChangePassword() {
    if (newPassword !== confirmNewPassword) {
      setError("Passwords do not match");
      return;
    }
    setChanging(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await backendFetch("/backend-proxy/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.detail ?? "Failed to change password");
        return;
      }
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      signOutTimer.current = setTimeout(() => signOut({ callbackUrl: "/login" }), 2000);
    } catch {
      setError("Unable to connect to server");
    } finally {
      setChanging(false);
    }
  }

  return (
    <>
      <SettingsPageHeader
        title="Profile"
        description="Your account identity and password."
        icon={User}
      />

      <div className="mx-auto max-w-2xl px-6 py-8 space-y-10">
        <section>
          <h2 className="text-sm font-semibold mb-3">Identity</h2>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">Name</dt>
            <dd className="text-sm">{session?.user?.name || "\u2014"}</dd>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">Email</dt>
            <dd className="text-sm">{session?.user?.email || "\u2014"}</dd>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">Role</dt>
            <dd className="text-sm">
              {session?.user?.is_admin ? (
                <span className="inline-flex items-center gap-1 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                  Admin
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  Member
                </span>
              )}
            </dd>
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-1">Change Password</h2>
          <p className="text-xs text-muted-foreground mb-4">
            You will be signed out after a successful change.
          </p>

          <div className="space-y-3 max-w-sm">
            <div>
              <label htmlFor="current-password" className="text-xs text-muted-foreground mb-1 block">
                Current password
              </label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                className="h-9"
              />
            </div>
            <div>
              <label htmlFor="new-password" className="text-xs text-muted-foreground mb-1 block">
                New password
              </label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className="h-9"
              />
            </div>
            <div>
              <label htmlFor="confirm-new-password" className="text-xs text-muted-foreground mb-1 block">
                Confirm new password
              </label>
              <Input
                id="confirm-new-password"
                type="password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                autoComplete="new-password"
                className="h-9"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {success && (
              <p className="text-xs text-success">Password changed. You will be signed out.</p>
            )}

            <Button
              type="button"
              onClick={handleChangePassword}
              disabled={changing || !currentPassword || !newPassword || !confirmNewPassword}
              size="sm"
            >
              {changing ? "Changing..." : "Change password"}
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
