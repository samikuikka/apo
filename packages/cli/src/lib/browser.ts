import { spawn } from "child_process";

export function tryOpenBrowser(url: string): boolean {
  const launch = resolveOpenCommand();
  if (!launch) {
    return false;
  }

  try {
    const child = spawn(launch.command, [...launch.args, url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function resolveOpenCommand(): { command: string; args: string[] } | null {
  if (process.platform === "darwin") {
    return { command: "open", args: [] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", ""] };
  }
  if (process.platform === "linux") {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      return { command: "xdg-open", args: [] };
    }
  }
  return null;
}
