/**
 * llms.txt — the agent-discovery index for the apo docs (llmstxt.org format).
 *
 * AI agents that land on the site (or are pointed here by a user) fetch this
 * file first. It states what apo is in one paragraph, then indexes every docs
 * page. Every link targets the `.md` rendition served by [...slug].md.ts —
 * clean markdown, no navigation chrome — so an agent never has to parse HTML.
 *
 * Generated from the content collection at build time, so it cannot drift:
 * editing a page's frontmatter title/description updates llms.txt on the next
 * build. The section order lists mirror the sidebar order in astro.config.mjs —
 * adding a page means the same two edits either way. Pages not covered by a
 * section list (a freshly added page awaiting sidebar wiring) still appear
 * under "More" so nothing is silently dropped from the index.
 */
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const ORIGIN = import.meta.env.SITE;

/**
 * Ordered slugs per section — the index an agent should read top to bottom.
 * Keep in sync with the sidebar order in astro.config.mjs.
 */
const SECTIONS: { heading: string; slugs: string[] }[] = [
	{
		heading: 'Start here',
		slugs: ['overview', 'why-apo', 'quickstart', 'concepts/mental-model'],
	},
	{
		heading: 'Concepts',
		slugs: [
			'concepts/tasks',
			'concepts/adapters',
			'concepts/tests',
			'concepts/traces',
			'concepts/schedules',
		],
	},
	{
		heading: 'Guides',
		slugs: ['guides/define-a-task', 'guides/run-and-debug', 'guides/loop-engineering'],
	},
	{
		heading: 'Self-hosting',
		slugs: [
			'self-hosting/topology',
			'self-hosting/public-server',
			'self-hosting/configuration',
		],
	},
	{
		heading: 'SDK reference (@apo-ai/sdk)',
		slugs: [
			'reference/overview',
			'reference/task',
			'reference/adapter',
			'reference/assertions',
			'reference/tracing-integrations',
			'reference/running',
			'reference/flow-normalizers',
			'reference/tracing',
		],
	},
	{
		heading: 'HTTP & operator reference',
		slugs: ['reference/schedule-schema', 'reference/configuration'],
	},
	{
		heading: 'CLI reference (@apo-ai/cli)',
		slugs: [
			'cli',
			'cli/auth',
			'cli/status',
			'cli/project',
			'cli/task-publish',
			'cli/task-run',
			'cli/task-list',
			'cli/task-show',
			'cli/connect',
			'cli/runs-list',
			'cli/runs-show',
			'cli/runs-deliverable',
			'cli/runs-rejudge',
			'cli/runs-correct',
			'cli/runs-judgments',
			'cli/traces-list',
			'cli/traces-show',
			'cli/traces-import-langfuse',
			'cli/batch',
		],
	},
	{
		heading: 'Ecosystem',
		slugs: ['ecosystem', 'ecosystem/otel-framework-setup', 'ecosystem/langfuse-import'],
	},
];

const INTRO = `# apo

> apo is an opinionated end-to-end testing framework for AI agents. It runs
> your real agent through an adapter, asserts on the deliverable it produced
> and the trace of what it did (code assertions and LLM judges), and returns a
> binary verdict — pass or fail — with the full evidence. Not a prompt-scoring
> tool, not an LLM-call optimizer, not an observability dashboard.

Usage: install the CLI from npm (\`npm install -g @apo-ai/cli\`), the SDK for
tasks (\`npm install @apo-ai/sdk\`), or self-host the server from source
(github.com/samikuikka/apo). Every page below also exists as rendered HTML at
the same path without the \`.md\` suffix.

- [Set up apo (complete agent skill)](${ORIGIN}/start.md): a self-contained
  guide for coding agents — discovery, adapter, first task, first run, debug
  loop. Start here if you are an agent helping a user adopt apo.
- [GitHub repository](https://github.com/samikuikka/apo): source, example
  service, self-hosting scripts.
- [npm: @apo-ai/sdk](https://www.npmjs.com/package/@apo-ai/sdk): task,
  adapter, assertions, and tracing APIs.
- [npm: @apo-ai/cli](https://www.npmjs.com/package/@apo-ai/cli): the \`apo\`
  command — task publish/run, runs, traces, connect.
`;

/** Map of slug → title/description, built from the docs collection. */
async function loadDocs(): Promise<Map<string, { title: string; description?: string }>> {
	const docs = await getCollection('docs');
	const pages = new Map<string, { title: string; description?: string }>();
	for (const entry of docs) {
		if (entry.data.draft === true) continue;
		const slug = entry.id.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
		pages.set(slug, {
			title: (entry.data.title as string) ?? slug,
			description: entry.data.description as string | undefined,
		});
	}
	return pages;
}

function formatLink(
	slug: string,
	page: { title: string; description?: string } | undefined,
): string {
	const title = page?.title ?? slug;
	const desc = page?.description ? `: ${page.description}` : '';
	return `- [${title}](${ORIGIN}/${slug}.md)${desc}`;
}

async function buildLlmsTxt(): Promise<string> {
	const pages = await loadDocs();
	const listed = new Set(SECTIONS.flatMap((s) => s.slugs));

	const sections = SECTIONS.map((section) => {
		// One pass: collect and format each listed slug the docs actually have.
		const links: string[] = [];
		for (const slug of section.slugs) {
			const page = pages.get(slug);
			if (page) links.push(formatLink(slug, page));
		}
		return links.length > 0 ? `## ${section.heading}\n\n${links.join('\n')}` : '';
	});

	// Anything not in a section list (e.g. a page added before sidebar wiring)
	// still belongs in the index — append it alphabetically rather than dropping it.
	const extras = [...pages.keys()]
		.filter((slug) => !listed.has(slug))
		.sort()
		.map((slug) => formatLink(slug, pages.get(slug)));
	if (extras.length > 0) sections.push(`## More\n\n${extras.join('\n')}`);

	return [INTRO, ...sections.filter(Boolean)].join('\n\n') + '\n';
}

export const GET: APIRoute = async () => {
	return new Response(await buildLlmsTxt(), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=60',
		},
	});
};
