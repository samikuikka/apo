import { AlertTriangle } from "lucide-react"
import type { ProjectFirstRunSetup } from "@/lib/first-run"
import { CopyCommand } from "./CopyCommand"

/**
 * The virgin-Project onboarding panel.
 *
 * Four concise stages from an accepted invitation to one recorded Task Run.
 * All commands are display-only structured strings; nothing executes here.
 * The panel disappears by itself once the Project publishes Tasks or
 * records Runs — there is no dismissal state.
 */
export function ProjectFirstRun({ setup }: { setup: ProjectFirstRunSetup }) {
  if (!setup.publicUrl || !setup.cliLoginCommand) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="border border-warning bg-warning/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="space-y-1 text-xs">
              <p className="font-semibold text-foreground">
                This installation is misconfigured
              </p>
              <p className="text-muted-foreground">
                The public origin (<code className="font-mono">APO_PUBLIC_URL</code>)
                is missing or invalid, so we can&rsquo;t show your exact login
                command. Ask the operator to set a valid <code className="font-mono">https://…</code>{" "}
                origin and reload this page.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <header className="space-y-1">
        <h1 className="text-[18px] font-semibold tracking-tight">
          Get your first recorded run
        </h1>
        <p className="text-[13px] text-muted-foreground">
          This Project is ready — empty, and yours. Four steps from here to a
          recorded, inspectable agent run.
        </p>
      </header>

      <ol className="space-y-8">
        <li className="space-y-2">
          <h2 className="text-sm font-semibold">
            <span className="mr-2 text-muted-foreground">1.</span>
            Install the CLI
          </h2>
          <CopyCommand
            command="npm install -g @apo-ai/cli"
            label="Install CLI"
          />
          <p className="text-xs text-muted-foreground">
            Requires Node.js ≥ 20.
          </p>
        </li>

        <li className="space-y-2">
          <h2 className="text-sm font-semibold">
            <span className="mr-2 text-muted-foreground">2.</span>
            Connect this Project
          </h2>
          <CopyCommand
            command={setup.cliLoginCommand}
            label="Login"
          />
          <p className="text-xs text-muted-foreground">
            You&rsquo;ll sign in with the email and password you just created. The
            CLI saves a Project-scoped API key on your machine — it is never
            shown in the browser.
          </p>
        </li>

        <li className="space-y-2">
          <h2 className="text-sm font-semibold">
            <span className="mr-2 text-muted-foreground">3.</span>
            Choose a Task source
          </h2>
          <div className="space-y-2">
            <a
              href={setup.docsUrl}
              className="block border border-border bg-card px-3 py-2.5 text-[13px] transition-colors hover:bg-muted/40"
            >
              <span className="font-medium text-foreground">
                Use APO in my own agent repository
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Install the SDK (<code className="font-mono">npm install @apo-ai/sdk</code>),
                define a Task, run it. Your provider credentials stay on your
                machine — APO never receives them.
              </span>
            </a>
            <a
              href={setup.exampleUrl}
              className="block border border-border bg-card px-3 py-2.5 text-[13px] transition-colors hover:bg-muted/40"
            >
              <span className="font-medium text-foreground">
                Try the maintained example
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                A ready task tree with fixtures — the fastest way to see a full
                recorded run end to end.
              </span>
            </a>
          </div>
        </li>

        <li className="space-y-2">
          <h2 className="text-sm font-semibold">
            <span className="mr-2 text-muted-foreground">4.</span>
            Publish and run locally
          </h2>
          <CopyCommand
            command="apo task publish --dir <task-root>"
            label="Publish"
          />
          <div className="h-1.5" />
          <CopyCommand
            command="apo task run <task-id> --dir <task-root>"
            label="Run"
          />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Replace this:</span>{" "}
            <code className="font-mono">&lt;task-root&gt;</code> is your tasks
            directory and <code className="font-mono">&lt;task-id&gt;</code> comes
            from <code className="font-mono">apo task list</code>. Publishing
            sends task metadata only — never your source code, fixtures, or
            secrets.
          </p>
          <p className="text-xs text-muted-foreground">
            The agent runs on <span className="text-foreground">your</span>{" "}
            machine; apo records the verdict, checks, traces, and deliverables.
            PASS and FAIL are both useful recorded outcomes — open{" "}
            <span className="text-foreground">Runs</span> when the command
            finishes to inspect the evidence.
          </p>
        </li>
      </ol>
    </div>
  )
}
