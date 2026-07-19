/**
 * [...slug].md.ts — serves raw markdown for every docs page.
 *
 * For each page in the `docs` content collection, this endpoint generates a
 * static `.md` file at build time: `/overview.md`, `/concepts/adapters.md`,
 * `/cli.md`, etc. Agents fetch these instead of the rendered HTML — cleaner
 * content, no navigation chrome, smaller payload.
 *
 * The body comes from the content collection's `entry.body` field — the raw
 * source markdown with frontmatter already stripped. For `.mdx` files, import
 * lines are stripped (they're build-time noise for an agent). Component tags
 * (e.g. `<TerminalDemo />`) are left in place — agents tolerate them, and
 * stripping JSX with regex risks orphaning surrounding prose.
 *
 * The title from frontmatter is prepended as an H1 so each file is
 * self-describing (since `body` excludes the frontmatter).
 *
 * This is the single source of truth for agent-readable docs: editing a source
 * `.md`/`.mdx` file updates both the HTML and the markdown automatically. No
 * sync step needed.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

export const getStaticPaths = (async () => {
	const docs = await getCollection('docs');
	return docs
		// Skip drafts and the homepage (entry.id is bare 'index' — collides
		// with root route and the standalone index.astro landing page).
		.filter((entry) => entry.data.draft !== true && entry.id !== 'index')
		.map((entry) => {
			const slug = entry.id.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
			// Strip import lines (MDX build noise), prepend title.
			const body = (entry.body ?? '')
				.split('\n')
				.filter((line) => !/^import\s.+from\s/.test(line.trim()))
				.join('\n')
				.trim();
			const title = (entry.data.title as string) ?? slug;
			return {
				params: { slug },
				props: { content: `# ${title}\n\n${body}` },
			};
		});
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
	return new Response(props.content, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Cache-Control': 'public, max-age=60',
		},
	});
};
