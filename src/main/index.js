// Kiri Studio main process: window, sign-in, site list, sync, and the file
// scope the renderer may read. The renderer is sandboxed and only sees the
// narrow API in src/preload/index.cjs.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, protocol, shell } from 'electron';
import { createTokenStore, pollForToken, requestDeviceCode } from './auth.js';
import { createClient } from './github.js';
import { listSites } from './sites.js';
import { readSyncState, syncSite } from './sync.js';
import { buildScope, inScope, isExcluded, mediaRootOf, readStudioConfig, schemaResolver } from './scope.js';
import { createCollections, creationTarget } from './collections.js';
import { createMedia } from './media.js';
import { createDrafts } from './drafts.js';
import { checkData } from './validate.js';

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
	smokeView: !!process.env.KIRI_STUDIO_SMOKE_VIEW,
	// Smoke tests: local files to add in the opened media manager.
	smokeFiles: (process.env.KIRI_STUDIO_SMOKE_ADD ?? '').split(path.delimiter).filter(Boolean).map((file) => ({
		name: path.basename(file),
		type: MIME[path.extname(file).toLowerCase()] ?? '',
		bytes: fs.readFileSync(file),
	})),
}));

ipcMain.handle('auth:status', async () => {
	if (user) return { signedIn: true, user };
	const token = tokens.load();
	// A local site needs no GitHub account (development, CI smoke tests).
	if (!token && localSite) return { signedIn: true, user: { login: 'local', name: 'Local', avatar: null } };
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

ipcMain.handle('app:copy', (_event, text) => {
	if (typeof text === 'string') clipboard.writeText(text);
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

// Development: KIRI_STUDIO_LOCAL_SITE=<folder> shows that local site instead
// of GitHub ones, as a client would see it (no sync; drafts kept apart).
const localSite = process.env.KIRI_STUDIO_LOCAL_SITE ? path.resolve(process.env.KIRI_STUDIO_LOCAL_SITE) : null;

ipcMain.handle('sites:list', async () => {
	if (localSite) {
		const name = path.basename(localSite);
		const title = (() => { try { return readStudioConfig(localSite).kirigami?.project; } catch { return null; } })() || name;
		return { sites: [{ fullName: `local/${name}`, owner: 'local', name, title, url: null, branch: null, local: true }], lastSite: null };
	}
	const sites = await listSites(gh);
	return { sites, lastSite: readPrefs().lastSite ?? null };
});

// Opens a site: syncs it, then returns its scope. When GitHub can't be
// reached, falls back to the last synced copy.
ipcMain.handle('site:open', async (_event, site) => {
	const dir = siteDir(site);
	const treeDir = localSite && site.local ? localSite : path.join(dir, 'tree');
	let status = 'ready';
	try {
		if (!site.local) await syncSite(gh, site, dir, (step) => send('sync:status', step));
	} catch (error) {
		if (!fs.existsSync(treeDir)) throw error;
		status = 'offline';
	}
	const scope = buildScope(treeDir);
	for (const collection of scope.collections) collection.creatable = collection.create && !!creationTarget(collection.pattern);
	const drafts = createDrafts(dir, treeDir);
	const excluded = (rel) => isExcluded(scope.exclude, rel);
	current = {
		site,
		treeDir,
		scope,
		drafts,
		media: createMedia({ treeDir, drafts, isExcluded: excluded }),
		collections: createCollections({ treeDir, drafts, scope, isExcluded: excluded }),
		// Schema of any data file, including one the client just created.
		schemaFor: schemaResolver(treeDir, readStudioConfig(treeDir).studio ?? {}, (rel) => drafts.read(rel)),
	};
	schemas.clear();
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
	if (!current || typeof rel !== 'string') throw new Error('Not editable.');
	if (!inScope(current.scope, rel) && !current.collections.contains(rel)) throw new Error('Not editable.');
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

// JSON Schemas of data files, loaded once per open site: from the synced copy
// (or the client's draft of it), or over HTTPS for a URL.
const schemas = new Map();
async function schemaOf(rel) {
	const ref = current.schemaFor(rel);
	if (!ref) return null;
	const id = ref.url ?? ref.path;
	if (!schemas.has(id)) {
		schemas.set(id, (async () => {
			try {
				if (ref.url) {
					if (!ref.url.startsWith('https://')) return null;
					const res = await fetch(ref.url);
					return res.ok ? await res.json() : null;
				}
				const file = path.resolve(current.treeDir, ref.path);
				if (!file.startsWith(path.resolve(current.treeDir) + path.sep)) return null;
				return JSON.parse(fs.readFileSync(file, 'utf8'));
			} catch (error) {
				// Unreachable or broken schema: the client edits without it; the
				// maintainer sees why in the app's log.
				console.warn(`Kiri Studio: schema ${id} unavailable: ${error.message}`);
				return null;
			}
		})());
	}
	return schemas.get(id);
}

ipcMain.handle('data:schema', (_event, rel) => schemaOf(editable(rel)));
ipcMain.handle('data:check', async (_event, rel, text) => {
	if (typeof text !== 'string') throw new Error('Text expected.');
	return checkData(text, await schemaOf(editable(rel)));
});

ipcMain.handle('drafts:discard', (_event, rel) => {
	current.drafts.discard(editable(rel));
	return current.drafts.list().map((draft) => draft.path);
});

// --- Collections -----------------------------------------------------------

ipcMain.handle('collection:files', (_event, pattern) => current.collections.files(pattern));

ipcMain.handle('collection:create', (_event, pattern, title) => ({
	path: current.collections.create(pattern, String(title)),
	changes: changes(),
}));

ipcMain.handle('collection:delete', (_event, rel) => {
	current.collections.delete(editable(rel));
	return { changes: changes() };
});

// --- Images and documents ------------------------------------------------------

// Checks that `rel` is inside a media folder; returns that folder.
const mediaRoot = (rel) => {
	const root = current && mediaRootOf(current.scope, rel);
	if (!root) throw new Error('Not editable.');
	return root;
};
const changes = () => current.drafts.list().map((draft) => draft.path);

ipcMain.handle('media:tree', (_event, root) => {
	if (mediaRoot(root) !== root) throw new Error('Not a media folder.');
	return current.media.tree(root);
});

ipcMain.handle('media:add', (_event, folder, name, bytes) => {
	if (!(bytes instanceof Uint8Array) || typeof name !== 'string') throw new Error('File expected.');
	const root = mediaRoot(folder);
	try {
		return { path: current.media.add(folder, name, Buffer.from(bytes), root), changes: changes() };
	} catch (error) {
		return { error: error.code ?? 'failed', changes: changes() };
	}
});

ipcMain.handle('media:mkdir', (_event, parent, name) => ({
	path: current.media.mkdir(parent, String(name), mediaRoot(parent)),
	changes: changes(),
}));

ipcMain.handle('media:rename', (_event, rel, name) => ({
	path: current.media.rename(rel, String(name), mediaRoot(rel)),
	changes: changes(),
}));

ipcMain.handle('media:delete', (_event, rel) => {
	current.media.delete(rel, mediaRoot(rel));
	return { changes: changes() };
});

// Which content mentions a file (or any file in a folder) by name, so the
// client is warned before renaming or deleting something a page uses.
ipcMain.handle('media:usage', (_event, rel) => {
	const root = mediaRoot(rel);
	const names = current.media.files(root)
		.filter((file) => file === rel || file.startsWith(`${rel}/`))
		.map((file) => path.posix.basename(file))
		.filter((name) => !name.startsWith('.'));
	const entries = [...current.scope.content, ...current.scope.collections.flatMap((c) => c.files)];
	return entries
		.filter((entry) => {
			const text = current.drafts.read(entry.path)?.toString('utf8') ?? '';
			return names.some((name) => text.includes(name));
		})
		.map((entry) => (entry.group && entry.group !== entry.label ? `${entry.group} › ${entry.label}` : entry.label));
});

// Thumbnails and previews: studio-media://site/<path>, the client's current
// version of a media file. Only media folders are served.
const MIME = {
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
	'.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf',
};
protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true } }]);
function serveMedia(request) {
	const rel = decodeURIComponent(new URL(request.url).pathname.slice(1));
	if (!current || !mediaRootOf(current.scope, rel)) return new Response(null, { status: 404 });
	const data = current.drafts.read(rel);
	if (!data) return new Response(null, { status: 404 });
	return new Response(data, {
		headers: {
			'Content-Type': MIME[path.posix.extname(rel).toLowerCase()] ?? 'application/octet-stream',
			// An SVG must not run scripts inside the app.
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
		},
	});
}

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
	if (process.env.KIRI_STUDIO_SCREENSHOT) {
		// Smoke tests: surface renderer errors in the terminal.
		win.webContents.on('console-message', ({ level, message }) => {
			if (level !== 'info' && level !== 'debug') console.log(`[renderer ${level}] ${message}`);
		});
	}

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
	protocol.handle('studio-media', serveMedia);
	createWindow();
	if (process.env.KIRI_STUDIO_SCREENSHOT) setTimeout(() => app.exit(1), 60_000);
});
app.on('window-all-closed', () => app.quit());
