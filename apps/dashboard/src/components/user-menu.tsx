"use client"

import Link from "next/link"
import { signOut, useSession } from "next-auth/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SettingsIcon } from "lucide-react"
import { SETTINGS_DEFAULT_SEGMENT } from "@/app/settings/nav-config"

const SETTINGS_HREF = `/settings/${SETTINGS_DEFAULT_SEGMENT}`

export function UserMenu() {
  const { data: session } = useSession()

  if (!session?.user) return null

  const initial = session.user.email.charAt(0).toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-colors"
          aria-label="User menu"
        >
          {initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="font-normal">
          <p className="text-xs font-medium truncate">{session.user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={SETTINGS_HREF} className="flex items-center gap-2">
            <SettingsIcon className="size-3.5" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => signOut({ redirectTo: "/login" })}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
