// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import astroMermaid from 'astro-mermaid';
import react from '@astrojs/react';

// apo docs — Astro Starlight.
// POC stage: docs-only, default Starlight look. Theming to the apo
// dark/monochrome/sharp-cornered identity (design.md) is the next step.
// https://starlight.astro.build/
export default defineConfig({
	site: 'https://apo.dev',
	integrations: [
		starlight({
			title: 'apo',
			logo: { src: './src/assets/signal-sphere-small.svg', alt: 'apo' },
			favicon: '/brand/signal-sphere-favicon-32.png',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/samikuikka/apo' },
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Overview', slug: 'overview' },
						{ label: 'Why apo', slug: 'why-apo' },
						{ label: 'Quickstart', slug: 'quickstart' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'Mental model', slug: 'concepts/mental-model' },
						{ label: 'Tasks', slug: 'concepts/tasks' },
						{ label: 'Adapters', slug: 'concepts/adapters' },
						{ label: 'Tests', slug: 'concepts/tests' },
						{ label: 'Traces', slug: 'concepts/traces' },
						{ label: 'Schedules', slug: 'concepts/schedules' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Define a Task', slug: 'guides/define-a-task' },
						{ label: 'Run and debug', slug: 'guides/run-and-debug' },
						{ label: 'Loop engineering', slug: 'guides/loop-engineering' },
					],
				},
				{
					label: 'Self-Hosting',
					items: [
						{ label: 'Alpha Topology', slug: 'self-hosting/topology' },
						{ label: 'Publish on a Domain', slug: 'self-hosting/public-server' },
						{ label: 'Configuration', slug: 'self-hosting/configuration' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Overview', slug: 'reference/overview' },
						{
							label: '@apo/sdk/agent-task',
							collapsed: false,
							items: [
								{ label: 'Task API', slug: 'reference/task' },
								{ label: 'Adapter API', slug: 'reference/adapter' },
								{ label: 'Assertions API', slug: 'reference/assertions' },
								{ label: 'Tracing integrations', slug: 'reference/tracing-integrations' },
								{ label: 'Running tasks', slug: 'reference/running' },
								{ label: 'Flow normalizers', slug: 'reference/flow-normalizers' },
							],
						},
						{
							label: '@apo/sdk',
							collapsed: false,
							items: [
								{ label: 'Tracing', slug: 'reference/tracing' },
							],
						},
						{
							label: 'HTTP & operator',
							collapsed: false,
							items: [
								{ label: 'Schedule API', slug: 'reference/schedule-schema' },
								{ label: 'Configuration', slug: 'reference/configuration' },
							],
						},
					],
				},
			{
				label: 'CLI',
				items: [
					{ label: 'Overview', slug: 'cli' },
					{ label: 'login / logout', slug: 'cli/auth' },
					{ label: 'project', slug: 'cli/project' },
					{
						label: 'task',
						collapsed: false,
						items: [
							{ label: 'task run', slug: 'cli/task-run' },
							{ label: 'task list', slug: 'cli/task-list' },
							{ label: 'task show', slug: 'cli/task-show' },
						],
					},
					{
						label: 'runs',
						collapsed: false,
						items: [
							{ label: 'runs list', slug: 'cli/runs-list' },
							{ label: 'runs show', slug: 'cli/runs-show' },
							{ label: 'runs deliverable', slug: 'cli/runs-deliverable' },
						],
					},
				{
					label: 'traces',
					collapsed: false,
					items: [
						{ label: 'traces list', slug: 'cli/traces-list' },
						{ label: 'traces show', slug: 'cli/traces-show' },
						{ label: 'traces import langfuse', slug: 'cli/traces-import-langfuse' },
					],
				},
					{
						label: 'batch',
						collapsed: false,
						items: [
							{ label: 'batch create / show / list', slug: 'cli/batch' },
						],
					},
				],
			},
			{
				label: 'Ecosystem',
				items: [
					{ label: 'Overview', slug: 'ecosystem' },
					{ label: 'OTLP framework setup', slug: 'ecosystem/otel-framework-setup' },
					{ label: 'Import a Langfuse trace', slug: 'ecosystem/langfuse-import' },
				],
			},
			],
			customCss: ['./src/styles/custom.css'],
			components: {
				// Hide the right-side TOC below 1536px (Flue's 2xl breakpoint) so the
				// content column gets the full main width and centers further right.
				// See src/components/TwoColumnContent.astro for the override.
				TwoColumnContent: './src/components/TwoColumnContent.astro',
				// Load Inter + JetBrains Mono from Google Fonts, matching Flue's docs.
				// Font-family is wired up in src/styles/custom.css via --sl-font.
				Head: './src/components/Head.astro',
				// Adds a centered signal-sphere cover above the H1 on selected pages
				// (e.g. Why apo), matching flue's DocsCover-above-the-title placement.
				// See src/components/PageTitle.astro for the page gating.
				PageTitle: './src/components/PageTitle.astro',
				// Splash hero: renders the animated signal sphere above the title.
				// See src/components/Hero.astro.
				Hero: './src/components/Hero.astro',
				// Section tabs (Guide / Reference / CLI / Ecosystem) in the
				// header. See src/lib/docs-navigation.ts for the section model.
				Header: './src/components/Header.astro',
				// Filters the sidebar to only the active section's groups.
				// See src/lib/docs-navigation.ts.
				Sidebar: './src/components/Sidebar.astro',
				// Renders sidebar groups as always-visible nested lists with no
				// collapse toggle — parent labels are plain headings, children
				// always show. Matches flue's sidebar. See SidebarSublist.astro.
				SidebarSublist: './src/components/SidebarSublist.astro',
			},
		}),
		astroMermaid(),
		react(),
	],
});
