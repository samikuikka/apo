"use client"

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { signIn, useSession } from "next-auth/react"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LogIn,
  Mail,
} from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  acceptInvitationCreateAccount,
  acceptInvitationExistingAccount,
  previewInvitationToken,
  type InvitationTokenPreview,
} from "@/lib/project-invitations-api"

const PASSWORD_RULES = [
  { id: "min-length", label: "At least 8 characters" },
  { id: "has-letter", label: "At least one letter" },
  { id: "has-number", label: "At least one number" },
] as const

function validatePassword(password: string) {
  return {
    minLength: password.length >= 8,
    hasLetter: /[a-zA-Z]/.test(password),
    hasNumber: /\d/.test(password),
  }
}

function PasswordRules({ password }: { password: string }) {
  if (password.length === 0) return null
  const checks = validatePassword(password)
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {PASSWORD_RULES.map((rule) => {
        const passed =
          rule.id === "min-length"
            ? checks.minLength
            : rule.id === "has-letter"
              ? checks.hasLetter
              : checks.hasNumber
        return (
          <li
            key={rule.id}
            className={passed ? "text-success" : "text-muted-foreground"}
          >
            {passed ? "✓" : "○"} {rule.label}
          </li>
        )
      })}
    </ul>
  )
}

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptInvitationForm />
    </Suspense>
  )
}

type ViewState =
  | { kind: "loading" }
  | { kind: "invalid"; reason: string | null }
  | { kind: "create-account"; preview: InvitationTokenPreview }
  | { kind: "existing-account"; preview: InvitationTokenPreview }
  | { kind: "accepted"; projectId: string }
  | { kind: "error"; message: string }

function AcceptInvitationForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const { data: session, status: sessionStatus } = useSession()

  const [view, setView] = useState<ViewState>({ kind: "loading" })

  // Create-account form state
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setView({ kind: "invalid", reason: "missing" })
      return
    }
    let cancelled = false
    setView({ kind: "loading" })
    previewInvitationToken(token)
      .then((preview) => {
        if (cancelled) return
        if (!preview.valid) {
          setView({ kind: "invalid", reason: preview.reason })
          return
        }
        setView({
          kind: preview.requires_account_creation ? "create-account" : "existing-account",
          preview,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setView({ kind: "error", message: "Unable to reach server." })
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const checks = validatePassword(password)
  const allChecksPassed = checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = password === confirmPassword
  const canSubmitCreate =
    allChecksPassed && passwordsMatch && name.trim().length > 0

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault()
    if (view.kind !== "create-account") return
    setFormError(null)
    if (password !== confirmPassword) {
      setFormError("Passwords do not match")
      return
    }
    setSubmitting(true)
    try {
      const result = await acceptInvitationCreateAccount({
        token,
        name: name.trim(),
        password,
      })
      // Auto-sign-in with the credentials just submitted.
      const signInResult = await signIn("credentials", {
        email: view.preview.email ?? "",
        password,
        redirect: false,
        redirectTo: `/project/${result.project_id}`,
      })
      if (signInResult?.error) {
        setFormError("Account created, but sign-in failed. Please log in.")
        router.push("/login")
        return
      }
      setView({ kind: "accepted", projectId: result.project_id })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to accept invitation")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleAcceptExistingAccount() {
    if (view.kind !== "existing-account") return
    setFormError(null)
    setSubmitting(true)
    try {
      const result = await acceptInvitationExistingAccount(token)
      setView({ kind: "accepted", projectId: result.project_id })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to accept invitation")
    } finally {
      setSubmitting(false)
    }
  }

  // -----------------------------------------------------------------------
  // Render branches
  // -----------------------------------------------------------------------

  if (view.kind === "loading") {
    return (
      <AuthShell>
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    )
  }

  if (view.kind === "error") {
    return (
      <AuthShell>
        <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {view.message}
        </p>
      </AuthShell>
    )
  }

  if (view.kind === "invalid") {
    const headline =
      view.reason === "expired"
        ? "This invitation has expired"
        : view.reason === "revoked"
          ? "This invitation has been revoked"
          : view.reason === "accepted"
            ? "This invitation has already been used"
            : view.reason === "missing"
              ? "No invitation token provided"
              : "This invitation is no longer valid"
    return (
      <AuthShell>
        <div className="text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-muted-foreground" />
          <h1 className="text-[18px] font-semibold">{headline}</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Ask a project admin to send you a new invitation link.
          </p>
          <Link href="/login">
            <Button type="button" variant="outline" className="mt-5 h-10 w-full">
              Back to sign in
            </Button>
          </Link>
        </div>
      </AuthShell>
    )
  }

  if (view.kind === "accepted") {
    return (
      <AuthShell>
        <div className="text-center">
          <CheckCircle2 className="mx-auto mb-3 size-8 text-success" />
          <h1 className="text-[18px] font-semibold">You&rsquo;re in!</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Redirecting you to your project…
          </p>
          <Link href={`/project/${view.projectId}`}>
            <Button type="button" className="mt-5 h-10 w-full">
              Go to project
              <ArrowRight className="size-4" />
            </Button>
          </Link>
        </div>
      </AuthShell>
    )
  }

  const { preview } = view

  // Existing-account path: if not signed in, prompt sign-in first.
  if (view.kind === "existing-account") {
    return (
      <ExistingAccountView
        preview={preview}
        token={token}
        sessionStatus={sessionStatus}
        sessionEmail={session?.user?.email}
        formError={formError}
        submitting={submitting}
        onAccept={handleAcceptExistingAccount}
      />
    )
  }

  // Create-account path
  return (
    <CreateAccountForm
      preview={preview}
      name={name}
      onNameChange={setName}
      password={password}
      onPasswordChange={setPassword}
      confirmPassword={confirmPassword}
      onConfirmPasswordChange={setConfirmPassword}
      passwordsMatch={passwordsMatch}
      canSubmitCreate={canSubmitCreate}
      formError={formError}
      submitting={submitting}
      onSubmit={handleCreateAccount}
    />
  )
}

function ExistingAccountView({
  preview,
  token,
  sessionStatus,
  sessionEmail,
  formError,
  submitting,
  onAccept,
}: {
  preview: InvitationTokenPreview
  token: string
  sessionStatus: "loading" | "authenticated" | "unauthenticated"
  sessionEmail: string | null | undefined
  formError: string | null
  submitting: boolean
  onAccept: () => void
}) {
  const signedIn = sessionStatus === "authenticated"
  const emailMatches =
    !!sessionEmail &&
    sessionEmail.toLowerCase() === (preview.email ?? "").toLowerCase()
  return (
    <AuthShell>
      <Header preview={preview} />
      {!signedIn ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            An account already exists for{" "}
            <span className="font-medium text-foreground">{preview.email}</span>.
            Sign in to accept this invitation.
          </p>
          {formError && (
            <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          )}
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(
              `/accept-invitation?token=${token}`,
            )}`}
          >
            <Button type="button" className="h-10 w-full">
              <LogIn className="size-4" />
              Sign in to accept
            </Button>
          </Link>
        </div>
      ) : !emailMatches ? (
        <div className="space-y-3">
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            You&rsquo;re signed in as <strong>{sessionEmail}</strong>, but
            this invitation is for <strong>{preview.email}</strong>. Sign out and
            back in with the invited email to accept it.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            You&rsquo;re signed in as{" "}
            <span className="font-medium text-foreground">{preview.email}</span>.
            Accept to join the project as <strong>{preview.role}</strong>.
          </p>
          {formError && (
            <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          )}
          <Button
            type="button"
            onClick={onAccept}
            disabled={submitting}
            className="h-10 w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Accepting…
              </>
            ) : (
              <>
                Accept invitation
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </div>
      )}
    </AuthShell>
  )
}

function CreateAccountForm({
  preview,
  name,
  onNameChange,
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  passwordsMatch,
  canSubmitCreate,
  formError,
  submitting,
  onSubmit,
}: {
  preview: InvitationTokenPreview
  name: string
  onNameChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  confirmPassword: string
  onConfirmPasswordChange: (value: string) => void
  passwordsMatch: boolean
  canSubmitCreate: boolean
  formError: string | null
  submitting: boolean
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <AuthShell>
      <Header preview={preview} />
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            required
            autoComplete="name"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            value={preview.email ?? ""}
            readOnly
            className="h-10 bg-muted/40 text-muted-foreground"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-xs text-muted-foreground">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            required
            autoComplete="new-password"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Create a password"
          />
          {password.length > 0 && <PasswordRules password={password} />}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword" className="text-xs text-muted-foreground">
            Confirm password
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            required
            autoComplete="new-password"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Repeat the password"
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-destructive">Passwords do not match</p>
          )}
        </div>

        {formError && (
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {formError}
          </p>
        )}

        <Button
          type="submit"
          disabled={submitting || !canSubmitCreate}
          className="group h-10 w-full"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Creating account
            </>
          ) : (
            <>
              Create account and join
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  )
}

function Header({ preview }: { preview: InvitationTokenPreview }) {
  return (
    <div className="mb-5 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10">
        <Mail className="size-5 text-primary" />
      </div>
      <h1 className="text-[20px] font-semibold">You&rsquo;re invited</h1>
      {preview.project_name && (
        <p className="mt-1 text-sm text-muted-foreground">
          Join <span className="font-medium text-foreground">{preview.project_name}</span>
          {preview.role && (
            <>
              {" "}as <span className="capitalize">{preview.role}</span>
            </>
          )}
        </p>
      )}
    </div>
  )
}
