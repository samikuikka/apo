import { parseArgs } from "../lib/args.ts";
import { fetchProjects } from "../lib/projects.ts";
import { highlightIds } from "../lib/prefix.ts";
import { dim, formatTable, red } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);

  let config;
  let projects;
  try {
    ({ config, projects } = await fetchProjects(flags));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message));
    return 2;
  }

  if (projects.length === 0) {
    console.log(dim("No projects found."));
    return 0;
  }

  const activeId = config.projectId;
  const idLabels = highlightIds(projects.map((p) => p.id));
  const rows = projects.map((p, i) => [
    p.id === activeId ? `${p.name} *` : p.name,
    idLabels[i],
    p.current_user_role ?? "\u2014",
  ]);
  console.log(formatTable(["Name", "ID", "Role"], rows));
  console.log("");
  console.log(dim(`${projects.length} project${projects.length === 1 ? "" : "s"}  (* = active; cyan = unique prefix you can pass)`));
  return 0;
}
