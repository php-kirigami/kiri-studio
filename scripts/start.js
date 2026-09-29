// Launches Kiri Studio in development. VS Code's integrated terminal sets
// ELECTRON_RUN_AS_NODE=1, which would make Electron run as plain Node, so the
// variable is dropped before spawning. Extra arguments are passed through.
import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(import.meta.dirname, '..');
spawn(electron, [root, ...process.argv.slice(2)], { stdio: 'inherit', env })
	.on('exit', (code) => process.exit(code ?? 0));
