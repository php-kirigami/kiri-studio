// Kiri Studio main process: window, sign-in, site list, sync, and the file
// scope the renderer may read. The renderer is sandboxed and only sees the
// narrow API in src/preload/index.cjs.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { createTokenStore, pollForToken, requestDeviceCode } from './auth.js';
import { createClient } from './github.js';
import { listSites } from './sites.js';
import { readSyncState, syncSite } from './sync.js';
import { buildScope, inScope } from './scope.js';
import { createDrafts } from './drafts.js';

app.setName('Kiri Studio');
if (process.env.KIRI_STUDIO_USER_DATA) app.setPath('userData', path.resolve(process.env.KIRI_STUDIO_USER_DATA));

const userData = app.getPath('userData');
const tokens = createTokenStore(userData);
const prefsFile = path.join(userData, 'preferences.json');

let win = null;
let gh = null;          // GitHub client for the signed-in user
let user = null;        // { login, name, avatar }
let signIn = null;      // pending device flow: { verificationUri, abort }
let current = null;     // open site: { site, treeDir, scope, drafts }

function readPrefs() {
	try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; }
}
function writePrefs(patch) {
	fs.mkdirSync(userData, { recursive: true });
	fs.writeFileSync(prefsFile, JSON.stringify({ ...readPrefs(), ...patch }, null, 2));
}

const send = (channel, data) => win?.webContents.send(channel, data);
const siteDir = (site) => path.join(userData, 'sites', site.fullName.replace('/', '__'));

async function useToken(token) {
	const client = createClient(token);
	const me = await client.json('/user');
	gh = client;
	user = { login: me.login, name: me.name || me.login, avatar: me.avatar_url };
	return user;
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
	version: app.getVersion(),
	// Smoke tests can force the UI language and open an entry by path.
	locale: process.env.KIRI_STUDIO_LOCALE || app.getLocale(),
	smokeOpen: process.env.KIRI_STUDIO_SMOKE_OPEN || null,
	smokeType: process.env.KIRI_STUDIO_SMOKE_TYPE || null,
}));

ipcMain.handle('auth:status', async () => {
	if (user) return { signedIn: true, user };
	const token = tokens.load();
	if (!token) return { signedIn: false };
	try {
		return { signedIn: true, user: await useToken(token) };
	} catch (error) {
		if (error.status === 401) {
			tokens.clear(); // revoked or uninstalled: sign in again
			return { signedIn: false };
		}
		return { signedIn: false, offline: error.status === 0 };
	}
});

// Starts a device-flow sign-in: copies the code, opens GitHub's page, and
// reports the outcome later through 'auth:changed'.
ipcMain.handle('auth:start', async () => {
	signIn?.abort.abort();
	const code = await requestDeviceCode();
	const abort = new AbortController();
	signIn = { verificationUri: code.verificationUri, abort };
	clipboard.writeText(code.userCode);
	shell.openExternal(code.verificationUri);

	pollForToken(code, abort.signal)
		.then(async (token) => {
			tokens.save(token);
			send('auth:changed', { signedIn: true, user: await useToken(token) });
		})
		.catch((error) => {
			if (error.code !== 'cancelled') send('auth:changed', { signedIn: false, error: error.code || 'failed' });
		})
		.finally(() => { if (signIn?.abort === abort) signIn = null; });

	return { userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: code.expiresIn };
});

ipcMain.handle('auth:reopen', () => {
	if (signIn) shell.openExternal(signIn.verificationUri);
});

ipcMain.handle('auth:signOut', () => {
	signIn?.abort.abort();
	tokens.clear();
	gh = user = current = null;
	writePrefs({ lastSite: null });
});

ipcMain.handle('sites:list', async () => {
	const sites = await listSites(gh);
	return { sites, lastSite: readPrefs().lastSite ?? null };
});

// Opens a site: syncs it, then returns its scope. When GitHub can't be
// reached, falls back to the last synced copy.
ipcMain.handle('site:open', async (_event, site) => {
	const dir = siteDir(site);
	const treeDir = path.join(dir, 'tree');
	let status = 'ready';
	try {
		await syncSite(gh, site, dir, (step) => send('sync:status', step));
	} catch (error) {
		if (!fs.existsSync(treeDir)) throw error;
		status = 'offline';
	}
	current = { site, treeDir, scope: buildScope(treeDir), drafts: createDrafts(dir, treeDir) };
	writePrefs({ lastSite: site.fullName });
	return {
		site,
		scope: current.scope,
		status,
		syncedAt: readSyncState(dir)?.syncedAt ?? null,
		changes: current.drafts.list().map((draft) => draft.path),
	};
});

const editable = (rel) => {
	if (!current || typeof rel !== 'string' || !inScope(current.scope, rel)) throw new Error('Not editable.');
	return rel;
};

// The client's current text of a file: their draft if any, else the synced one.
ipcMain.handle('site:read', (_event, rel) => ({
	text: current.drafts.read(editable(rel)).toString('utf8'),
	changed: current.drafts.has(rel),
}));

// Autosave target. Returns the paths with unpublished changes.
ipcMain.handle('drafts:save', (_event, rel, text) => {
	if (typeof text !== 'string') throw new Error('Text expected.');
	current.drafts.save(editable(rel), text);
	return current.drafts.list().map((draft) => draft.path);
});

ipcMain.handle('drafts:discard', (_event, rel) => {
	current.drafts.discard(editable(rel));
	return current.drafts.list().map((draft) => draft.path);
});

ipcMain.handle('site:openLive', () => {
	if (current?.site.url) shell.openExternal(current.site.url);
});

// Smoke tests: capture the window once the renderer reports the wanted screen.
ipcMain.on('ui:settled', async (_event, screen) => {
	const file = process.env.KIRI_STUDIO_SCREENSHOT;
	if (!file || screen !== (process.env.KIRI_STUDIO_SMOKE_SCREEN || 'workspace')) return;
	await new Promise((resolve) => setTimeout(resolve, 400));
	fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
	app.exit(0);
});

// --- Window ----------------------------------------------------------------

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 900,
		minHeight: 600,
		show: false,
		title: 'Kiri Studio',
		backgroundColor: '#f6f4ef',
		webPreferences: {
			preload: path.join(import.meta.dirname, '..', 'preload', 'index.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	win.removeMenu();
	win.once('ready-to-show', () => win.show());

	// Before closing, let the renderer save what's being typed (autosave waits
	// half a second after the last keystroke). Close anyway after 3 seconds.
	let closing = false;
	win.on('close', (event) => {
		if (closing) return;
		event.preventDefault();
		closing = true;
		const done = () => win?.destroy();
		ipcMain.once('app:readyToClose', done);
		setTimeout(done, 3000);
		send('app:beforeClose');
	});
	win.on('closed', () => { win = null; });

	// The renderer never navigates or opens windows; links go to the browser.
	win.webContents.on('will-navigate', (event) => event.preventDefault());
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('https://')) shell.openExternal(url);
		return { action: 'deny' };
	});

	win.loadFile(path.join(import.meta.dirname, '..', '..', 'build', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
	createWindow();
	if (process.env.KIRI_STUDIO_SCREENSHOT) setTimeout(() => app.exit(1), 60_000);
});
app.on('window-all-closed', () => app.quit());
