// End-to-end smoke test: launches the real app on the fixture site (no GitHub
// account needed) in a few scenarios, and checks each one reaches its screen,
// saves a screenshot, and logs no renderer error. Run `npm run build` first.
//
//   node scripts/smoke.js [outDir]    screenshots go to outDir (default: build/smoke)
//
// Linux without a display runs under xvfb-run; CI passes --no-sandbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'build', 'smoke'));
const fixture = path.join(root, 'test', 'fixtures', 'site');
fs.mkdirSync(outDir, { recursive: true });

const only = process.env.SMOKE_ONLY;
const scenarios = [
	{ name: 'markdown', screen: 'entry', open: 'src/_home.md', type: '\nAdded by the smoke test.\n' },
	{ name: 'yaml', screen: 'entry', open: 'src/_data/team.yaml', type: '- name: Grace\n  job: Pastry\n' },
	{ name: 'images', screen: 'entry', open: 'media:images', add: [path.join(fixture, 'assets', 'images', 'storefront.png')] },
	{ name: 'viewer', screen: 'entry', open: 'media:images', view: true },
	{ name: 'workspace-fr', screen: 'workspace', locale: 'fr' },
	// A change whose file someone else published since: the editor says so.
	{ name: 'outdated', screen: 'entry', open: 'src/_home.md',
		drafts: { 'src/_home.md': { base: '0'.repeat(64), text: '# Home\n\nMy version.\n' } } },
	// Installs the fixture's dependencies from its lockfile, then renders it.
	// The typed text must reach the page Kirigami generated in the preview copy.
	{ name: 'preview', screen: 'entry', open: 'src/_home.md', preview: true, type: '\nTyped in Kiri Studio.\n',
		expect: { file: 'sites/local__site/preview/src/index.html', contains: 'Typed in Kiri Studio.' } },
];

let failed = 0;
for (const scenario of scenarios.filter((s) => !only || s.name === only)) {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-smoke-'));
	const screenshot = path.join(outDir, `${scenario.name}.png`);
	// Unpublished changes to start with, as drafts.js stores them.
	if (scenario.drafts) {
		const dir = path.join(userData, 'sites', 'local__site', 'drafts');
		const index = {};
		for (const [rel, { base, text }] of Object.entries(scenario.drafts)) {
			fs.mkdirSync(path.dirname(path.join(dir, 'files', rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, 'files', rel), text);
			index[rel] = { base, updatedAt: new Date().toISOString() };
		}
		fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
	}
	fs.rmSync(screenshot, { force: true });
	const env = {
		...process.env,
		KIRI_STUDIO_LOCAL_SITE: fixture,
		KIRI_STUDIO_USER_DATA: userData,
		KIRI_STUDIO_SCREENSHOT: screenshot,
		KIRI_STUDIO_SMOKE_SCREEN: scenario.screen,
		KIRI_STUDIO_LOCALE: scenario.locale ?? 'en',
		...(scenario.open && { KIRI_STUDIO_SMOKE_OPEN: scenario.open }),
		...(scenario.type && { KIRI_STUDIO_SMOKE_TYPE: scenario.type }),
		...(scenario.add && { KIRI_STUDIO_SMOKE_ADD: scenario.add.join(path.delimiter) }),
		...(scenario.view && { KIRI_STUDIO_SMOKE_VIEW: '1' }),
		...(scenario.preview && { KIRI_STUDIO_SMOKE_PREVIEW: '1' }),
	};
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.KIRI_STUDIO_TOKEN;

	// CI Linux: no sandbox (no setuid helper) and no GPU (xvfb has none).
	const args = [root, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])];
	const headless = process.platform === 'linux' && !process.env.DISPLAY;
	const run = headless
		? spawnSync('xvfb-run', ['-a', electron, ...args], { env, encoding: 'utf8', timeout: 180_000 })
		: spawnSync(electron, args, { env, encoding: 'utf8', timeout: 180_000 });
	const expected = scenario.expect && path.join(userData, scenario.expect.file);
	const produced = expected && fs.existsSync(expected) ? fs.readFileSync(expected, 'utf8') : '';
	fs.rmSync(userData, { recursive: true, force: true });

	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	const errors = output.split('\n').filter((line) => line.startsWith('[renderer error]'));
	const problems = [];
	if (run.status !== 0) problems.push(`exit code ${run.status ?? run.signal}`);
	if (!fs.existsSync(screenshot)) problems.push('no screenshot');
	if (errors.length) problems.push(...errors);
	if (scenario.expect && !produced.includes(scenario.expect.contains)) problems.push(`${scenario.expect.file} lacks "${scenario.expect.contains}"`);

	if (problems.length) {
		failed++;
		console.log(`✖ ${scenario.name}\n  ${problems.join('\n  ')}\n${output.split('\n').slice(-20).join('\n')}`);
	} else {
		console.log(`✔ ${scenario.name} → ${path.relative(root, screenshot)}`);
	}
}

process.exit(failed ? 1 : 0);
