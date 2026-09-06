"use client"

import { Suspense, useEffect, useReducer } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { signIn, useSession } from "next-auth/react"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LogIn,
  Sparkles,
} from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { PasswordRules } from "@/components/auth/password-rules"
import { validatePassword } from "@/lib/password-policy"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  acceptHostedAccessCreateAccount,
  acceptHostedAccessExistingAccount,
  previewHostedAccessToken,
  type HostedAccessPreview,
} from "@/lib/hosted-access-api"

export default function JoinPage() {
  return (
    <Suspense>
      <JoinForm />
    </Suspense>
  )
}

type ViewState =
  | { kind: "loading" }
  | { kind: "invalid"; reason: string | null }
  | { kind: "create-account"; preview: HostedAccessPreview }
  | { kind: "existing-account"; preview: HostedAccessPreview }
  | { kind: "accepted"; projectId: string }
  | { kind: "error"; message: string }

type JoinState = {
  view: ViewState
  name: string
  password: string
  confirmPassword: string
  projectName: string
  submitting: boolean
  formError: string | null
}

type JoinAction =
  | { type: "PREVIEW_LOADING" }
  | { type: "PREVIEW_INVALID"; reason: string | null }
  | { type: "PREVIEW_LOADED"; preview: HostedAccessPreview }
  | { type: "PREVIEW_FAILED" }
  | {
      type: "SET_FIELD"
      field: "name" | "password" | "confirmPassword" | "projectName"
      value: string
    }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "ACCEPTED"; projectId: string }

const initialJoinState: JoinState = {
  view: { kind: "loading" },
  name: "",
  password: "",
  confirmPassword: "",
  projectName: "",
  submitting: false,
  formError: null,
}

function joinReducer(state: JoinState, action: JoinAction): JoinState {
  switch (action.type) {
    case "PREVIEW_LOADING":
      return { ...state, view: { kind: "loading" } }
    case "PREVIEW_INVALID":
      return { ...state, view: { kind: "invalid", reason: action.reason } }
    case "PREVIEW_LOADED":
      return {
        ...state,
        view: {
          kind: action.preview.requires_account_creation
            ? "create-account"
            : "existing-account",
          preview: action.preview,
        },
      }
    case "PREVIEW_FAILED":
      return {
        ...state,
        view: { kind: "error", message: "Unable to reach server." },
      }
    case "SET_FIELD":
      return { ...state, [action.field]: action.value }
    case "SUBMIT_START":
      return { ...state, submitting: true, formError: null }
    case "SUBMIT_ERROR":
      return { ...state, submitting: false, formError: action.message }
    case "ACCEPTED":
      return {
        ...state,
        submitting: false,
        view: { kind: "accepted", projectId: action.projectId },
      }
  }
}

function JoinForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const { data: session, status: sessionStatus } = useSession()

  const [state, dispatch] = useReducer(joinReducer, initialJoinState)
  const {
    view,
    name,
    password,
    confirmPassword,
    projectName,
    submitting,
    formError,
  } = state

  useEffect(() => {
    if (!token) {
      dispatch({ type: "PREVIEW_INVALID", reason: "missing" })
      return
    }
    const controller = new AbortController()
    dispatch({ type: "PREVIEW_LOADING" })
    previewHostedAccessToken(token, controller.signal)
      .then((preview) => {
        if (controller.signal.aborted) return
        if (!preview.valid) {
          dispatch({ type: "PREVIEW_INVALID", reason: preview.reason })
          return
        }
        dispatch({ type: "PREVIEW_LOADED", preview })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === "AbortError") return
        dispatch({ type: "PREVIEW_FAILED" })
      })
    return () => {
      controller.abort()
    }
  }, [token])

  const checks = validatePassword(password)
  const allChecksPassed = checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = password === confirmPassword
  const canSubmitCreate =
    allChecksPassed && passwordsMatch && name.trim().length > 0 &&
    projectName.trim().length > 0

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault()
    if (view.kind !== "create-account") return
    if (password !== confirmPassword) {
      dispatch({ type: "SUBMIT_ERROR", message: "Passwords do not match" })
      return
    }
    dispatch({ type: "SUBMIT_START" })
    try {
      const result = await acceptHostedAccessCreateAccount({
        token,
        name: name.trim(),
        password,
        project_name: projectName.trim(),
      })
      // Auto-sign-in with the credentials just submitted, then land on
      // the new Project's task list.
      const signInResult = await signIn("credentials", {
        email: view.preview.email ?? "",
        password,
        redirect: false,
        redirectTo: `/project/${result.project_id}/tasks`,
      })
      if (signInResult?.error) {
        dispatch({
          type: "SUBMIT_ERROR",
          message: "Account created, but sign-in failed. Please log in.",
        })
        router.push("/login")
        return
      }
      dispatch({ type: "ACCEPTED", projectId: result.project_id })
      router.push(`/project/${result.project_id}/tasks`)
    } catch (err) {
      dispatch({
        type: "SUBMIT_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to accept invitation",
      })
    }
  }

  async function handleAcceptExistingAccount() {
    if (view.kind !== "existing-account") return
    dispatch({ type: "SUBMIT_START" })
    try {
      const result = await acceptHostedAccessExistingAccount(
        token,
        projectName.trim(),
      )
      dispatch({ type: "ACCEPTED", projectId: result.project_id })
      router.push(`/project/${result.project_id}/tasks`)
    } catch (err) {
      dispatch({
        type: "SUBMIT_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to accept invitation",
      })
    }
  }

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
            Ask the apo administrator for a new invitation link.
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
          <h1 className="text-[18px] font-semibold">Welcome to apo</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Redirecting you to your Project…
          </p>
          <Link href={`/project/${view.projectId}/tasks`}>
            <Button type="button" className="mt-5 h-10 w-full">
              Go to your Project
              <ArrowRight className="size-4" />
            </Button>
          </Link>
        </div>
      </AuthShell>
    )
  }

  const { preview } = view

  if (view.kind === "existing-account") {
    return (
      <ExistingAccountView
        preview={preview}
        token={token}
        projectName={projectName}
        onProjectNameChange={(value) =>
          dispatch({ type: "SET_FIELD", field: "projectName", value })
        }
        sessionStatus={sessionStatus}
        sessionEmail={session?.user?.email}
        formError={formError}
        submitting={submitting}
        onAccept={handleAcceptExistingAccount}
      />
    )
  }

  return (
    <CreateAccountForm
      preview={preview}
      name={name}
      onNameChange={(value) =>
        dispatch({ type: "SET_FIELD", field: "name", value })
      }
      password={password}
      onPasswordChange={(value) =>
        dispatch({ type: "SET_FIELD", field: "password", value })
      }
      confirmPassword={confirmPassword}
      onConfirmPasswordChange={(value) =>
        dispatch({ type: "SET_FIELD", field: "confirmPassword", value })
      }
      projectName={projectName}
      onProjectNameChange={(value) =>
        dispatch({ type: "SET_FIELD", field: "projectName", value })
      }
      passwordsMatch={passwordsMatch}
      canSubmitCreate={canSubmitCreate}
      formError={formError}
      submitting={submitting}
      onSubmit={handleCreateAccount}
    />
  )
}

function JoinHeader() {
  return (
    <div className="mb-5 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10">
        <Sparkles className="size-5 text-primary" />
      </div>
      <h1 className="text-[20px] font-semibold">Create your apo Project</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your invitation admits you to this apo installation and creates a
        Project of your own.
      </p>
    </div>
  )
}

function ProjectNameField({
  projectName,
  onChange,
}: {
  projectName: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="projectName" className="text-xs text-muted-foreground">
        Project name
      </Label>
      <Input
        id="projectName"
        type="text"
        value={projectName}
        onChange={(e) => onChange(e.target.value)}
        required
        maxLength={100}
        className="h-10 bg-input/50 ring-1 ring-white/10"
        placeholder="e.g. My evaluations"
      />
    </div>
  )
}

function ExistingAccountView({
  preview,
  token,
  projectName,
  onProjectNameChange,
  sessionStatus,
  sessionEmail,
  formError,
  submitting,
  onAccept,
}: {
  preview: HostedAccessPreview
  token: string
  projectName: string
  onProjectNameChange: (value: string) => void
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
      <JoinHeader />
      {!signedIn ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            An account already exists for{" "}
            <span className="font-medium text-foreground">{preview.email}</span>.
            Sign in with that email to accept this invitation.
          </p>
          {formError && (
            <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          )}
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(
              `/join?token=${token}`,
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
            You&rsquo;re signed in as <strong>{sessionEmail}</strong>, but this
            invitation is for <strong>{preview.email}</strong>. Sign out and
            back in with the invited email to accept it.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            You&rsquo;re signed in as{" "}
            <span className="font-medium text-foreground">{preview.email}</span>.
            Accepting creates a new Project that only you own.
          </p>
          <ProjectNameField
            projectName={projectName}
            onChange={onProjectNameChange}
          />
          {formError && (
            <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          )}
          <Button
            type="button"
            onClick={onAccept}
            disabled={submitting || projectName.trim().length === 0}
            className="h-10 w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Accepting…
              </>
            ) : (
              <>
                Accept and create Project
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
  projectName,
  onProjectNameChange,
  passwordsMatch,
  canSubmitCreate,
  formError,
  submitting,
  onSubmit,
}: {
  preview: HostedAccessPreview
  name: string
  onNameChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  confirmPassword: string
  onConfirmPasswordChange: (value: string) => void
  projectName: string
  onProjectNameChange: (value: string) => void
  passwordsMatch: boolean
  canSubmitCreate: boolean
  formError: string | null
  submitting: boolean
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <AuthShell>
      <JoinHeader />
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
          <Label
            htmlFor="confirmPassword"
            className="text-xs text-muted-foreground"
          >
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

        <ProjectNameField projectName={projectName} onChange={onProjectNameChange} />

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
              Creating your Project
            </>
          ) : (
            <>
              Create account and Project
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  )
}
