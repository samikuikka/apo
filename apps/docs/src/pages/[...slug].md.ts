/**
 * [...slug].md.ts, serves raw markdown for every docs page.
 *
 * For each page in the `docs` content collection, this endpoint generates a
 * static `.md` file at build time: `/overview.md`, `/concepts/adapters.md`,
 * `/cli.md`, etc. Agents fetch these instead of the rendered HTML, cleaner
 * content, no navigation chrome, smaller payload.
 *
 * The body comes from the content collection's `entry.body` field, the raw
 * source markdown with frontmatter already stripped. For `.mdx` files, import
 * lines are stripped (they're build-time noise for an agent). Component tags
 * (e.g. `<TerminalDemo />`) are left in place, agents tolerate them, and
 * stripping JSX with regex risks orphaning surrounding prose.
 *
 * The title from frontmatter is prepended as an H1 so each file is
 * self-describing (since `body` excludes the frontmatter), followed by a
 * short provenance header: a one-line framing of what apo is, the page's
 * frontmatter description, and the rendered HTML URL. Chat platforms that
 * fetch and cite these raw markdown URLs (ChatGPT etc.) show only the first
 * heading and a line count, so the heading must carry "apo" and the first
 * lines must say what apo is, otherwise the citation says nothing about
 * the product.
 *
 * This is the single source of truth for agent-readable docs: editing a source
 * `.md`/`.mdx` file updates both the HTML and the markdown automatically. No
 * sync step needed.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

const ORIGIN = import.meta.env.SITE;

/** One-line product framing, shared by every generated .md page. */
const APO_FRAMING = 'apo: capability testing for agent harnesses';

export const getStaticPaths = (async () => {
	const docs = await getCollection('docs');
	return docs.flatMap((entry) => {
		// Skip drafts and the homepage (entry.id is bare 'index', collides
		// with root route and the standalone index.astro landing page).
		if (entry.data.draft === true || entry.id === 'index') return [];
		const slug = entry.id.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
		// Strip import lines (MDX build noise), prepend title.
		const body = (entry.body ?? '')
			.split('\n')
			.filter((line) => !/^import\s.+from\s/.test(line.trim()))
			.join('\n')
			.trim();
		const title = (entry.data.title as string) ?? slug;
		const description = entry.data.description as string | undefined;
		const header = [
			`# ${title} | apo`,
			'',
			`> ${APO_FRAMING}${description ? `. ${description}` : ''}`,
			`> Docs index: ${ORIGIN}/llms.txt, this page as HTML: ${ORIGIN}/${slug}/`,
			'',
		].join('\n');
		return [
			{
				params: { slug },
				props: { content: `${header}\n${body}` },
			},
		];
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
