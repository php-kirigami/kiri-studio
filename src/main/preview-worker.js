// Runs in an Electron utilityProcess whose cwd is the site's preview copy:
// loads the site's own Kirigami (its node_modules) and serves it with live
// rebuilds. Reports to the main process over parentPort:
//   { type: 'ready', url }  { type: 'build', status, rule, success, error }
//   { type: 'error', message }
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const post = (message) => process.parentPort.postMessage(message);

try {
	const entry = path.join(process.cwd(), 'node_modules', '@kirigami', 'kirigami', 'index.js');
	const core = await import(pathToFileURL(entry).href);
	const project = await core.load();
	const server = await project.serve({
		port: 0,
		host: '127.0.0.1',
		onBuildResult: (result) => post({
			type: 'build',
			status: result.status,
			rule: result.rule ?? null,
			success: result.success !== false,
			error: result.error ? String(result.error) : null,
		}),
	});
	post({ type: 'ready', url: server.url });

	process.parentPort.on('message', async ({ data }) => {
		if (data?.type !== 'stop') return;
		await server.close().catch(() => {});
		process.exit(0);
	});
} catch (error) {
	post({ type: 'error', message: String(error?.message ?? error) });
	process.exit(1);
}
