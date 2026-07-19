import { parseArgs, getFlagValue } from "../lib/args.ts";
import { fetchProjects, resolveProject } from "../lib/projects.ts";
import { readCredentials, writeCredentials } from "../lib/credentials.ts";
import { pickOption } from "../lib/picker.ts";
import { dim, green, red } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv);

  const existing = readCredentials();
  if (!existing) {
    console.error(red("Not logged in. Run `apo login` first."));
    return 2;
  }

  let projects;
  try {
    ({ projects } = await fetchProjects(flags));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message));
    return 2;
  }

  // Target: a positional id/name/prefix, the --project flag, or a picker.
  const target = positional[0] ?? getFlagValue(flags, "project");
  let chosen: (typeof projects)[number] | undefined;
  if (target) {
    const result = resolveProject(projects, target);
    if (result.status === "none") {
      console.error(red(`No project matching "${target}".`));
      if (projects.length > 0) {
        console.error(dim(`  Your projects: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}`));
      }
      return 2;
    }
    if (result.status === "ambiguous") {
      console.error(red(`"${target}" matches multiple projects:`));
      console.error(dim(`  ${result.items.map((p) => `${p.id} (${p.name})`).join(", ")}`));
      console.error(dim("  Use a longer prefix."));
      return 2;
    }
    chosen = result.item;
  } else if (projects.length === 0) {
    console.error(red("No projects available."));
    return 2;
  } else if (projects.length === 1) {
    chosen = projects[0];
  } else {
    const defaultIndex = Math.max(
      0,
      projects.findIndex((p) => p.id === existing.project),
    );
    const pickedId = await pickOption(
      "Select a project",
      projects.map((p) => ({ label: p.name, value: p.id, hint: p.id })),
      defaultIndex,
    );
    if (!pickedId) {
      return 2;
    }
    chosen = projects.find((p) => p.id === pickedId);
  }

  if (!chosen) {
    console.error(red("No project selected."));
    return 2;
  }

  if (chosen.id === existing.project) {
    console.log(dim(`Already using ${chosen.name} (${chosen.id}).`));
    return 0;
  }

  writeCredentials({ ...existing, project: chosen.id });
  console.log(green(`\u2713 Switched to ${chosen.name} (${chosen.id}).`));
  console.log(dim(`  Run \`apo project list\` to see all your projects.`));
  return 0;
}
