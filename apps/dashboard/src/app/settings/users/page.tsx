import { auth } from "@/auth";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { UsersAdmin } from "@/components/users/users-admin";
import { listUsers } from "@/lib/users-api";
import { UserCog } from "lucide-react";

export const metadata = {
  title: "Users",
  description: "Accounts on this apo installation",
};

export default async function UsersSettingsPage() {
  const session = await auth();
  const user = session?.user;

  if (user?.is_admin !== true) {
    return (
      <>
        <SettingsPageHeader
          title="Users"
          description="Accounts on this apo installation"
          icon={UserCog}
        />
        <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-muted-foreground">
          Administrator access required.
        </div>
      </>
    );
  }

  // Prefetch server-side so the table renders without a mount fetch; on
  // failure the prop is null and the client falls back to a fresh load
  // with its own error state.
  const [usersResult] = await Promise.allSettled([listUsers()]);
  const initialUsers =
    usersResult.status === "fulfilled" ? usersResult.value : null;

  return (
    <>
      <SettingsPageHeader
        title="Users"
        description="Deactivate an account to lock it out everywhere; projects and data are never deleted here."
        icon={UserCog}
      />
      <UsersAdmin initialUsers={initialUsers} currentUserId={user.id} />
    </>
  );
}
