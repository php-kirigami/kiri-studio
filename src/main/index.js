// Kiri Studio main process: window, sign-in, site list, sync, and the file
// scope the renderer may read. The renderer is sandboxed and only sees the
// narrow API in src/preload/index.cjs.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import { createTokenStore, pollForToken, requestDeviceCode } from './auth.js';
import { createClient } from './github.js';
import { INSTALL_URL, listSites } from './sites.js';
import { readSyncState, syncSite } from './sync.js';
import { buildScope, inScope, isExcluded, mediaRootOf, readStudioConfig, schemaResolver } from './scope.js';
import { createCollections, creationTarget, isTree } from './collections.js';
import { createMedia } from './media.js';
import { createDrafts } from './drafts.js';
import { checkData } from './validate.js';
import { createPreview } from './preview.js';
import { createSecrets } from './secrets.js';
import { installUpdate, startUpdates } from './updates.js';
import { publishSite, describeChanges, takeGenerated } from './publish.js';
import { watchDeploy } from './deploy.js';
import { createLfs, createLfsStore, parsePointer } from './lfs.js';
import { maxFileSize } from '../shared/lfs.js';
import { bytesResponse } from './lib/range.js';

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
	writePrefs({ user }); // for the next launch without internet
	return user;
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
	version: app.getVersion(),
	// Set on the first launch after an update: the renderer shows a short note.
	updated: updatedFrom ? app.getVersion() : null,
	// Smoke tests can force the UI language and open an entry by path.
	locale: process.env.KIRI_STUDIO_LOCALE || app.getLocale(),
	smokeOpen: process.env.KIRI_STUDIO_SMOKE_OPEN || null,
	smokeType: process.env.KIRI_STUDIO_SMOKE_TYPE || null,
	smokeView: !!process.env.KIRI_STUDIO_SMOKE_VIEW,
	smokePlay: !!process.env.KIRI_STUDIO_SMOKE_PLAY,
	smokePreview: !!process.env.KIRI_STUDIO_SMOKE_PREVIEW,
	smokeCollapse: !!process.env.KIRI_STUDIO_SMOKE_COLLAPSE,
	smokeMenu: !!process.env.KIRI_STUDIO_SMOKE_MENU,
	smokePageImage: !!process.env.KIRI_STUDIO_SMOKE_PAGE_IMAGE,
	smokePublish: !!process.env.KIRI_STUDIO_SMOKE_PUBLISH,
	smokePick: !!process.env.KIRI_STUDIO_SMOKE_PICK, // show the site list even with one site
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
		// No internet: carry on as the last signed-in user, on the sites as
		// last synced; GitHub is tried again at each sync.
		const known = readPrefs().user;
		if (error.status === 0 && known) {
			gh = createClient(token);
			user = known;
			return { signedIn: true, user, offline: true };
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

// Opens the live preview (a local address) in the browser; nothing else.
ipcMain.handle('app:openPreview', (_event, url) => {
	if (typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('auth:reopen', () => {
	if (signIn) shell.openExternal(signIn.verificationUri);
});

ipcMain.handle('auth:signOut', () => {
	signIn?.abort.abort();
	tokens.clear();
	current?.preview.stop();
	gh = user = current = null;
	writePrefs({ lastSite: null, user: null, sites: null });
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
	const { lastSite = null, sites: known } = readPrefs();
	try {
		const sites = await listSites(gh);
		writePrefs({ sites });
		return { sites, lastSite };
	} catch (error) {
		// No internet: the list as it was last time (their copies are local).
		if (error.status === 0 && known?.length) return { sites: known, lastSite, offline: true };
		throw error;
	}
});

// What the client may edit in the synced copy, and the helpers built on it.
// Rebuilt whenever the synced copy changes.
function loadScope(treeDir, drafts) {
	const scope = buildScope(treeDir);
	for (const collection of scope.collections) {
		collection.creatable = collection.create && !!creationTarget(collection.pattern);
		collection.tree = isTree(collection.pattern);
	}
	const excluded = (rel) => isExcluded(scope.exclude, rel);
	return {
		scope,
		media: createMedia({ treeDir, drafts, isExcluded: excluded, maxSize: (rel) => maxFileSize(scope.lfs, rel) }),
		collections: createCollections({ treeDir, drafts, scope, isExcluded: excluded }),
		// Schema of any data file, including one the client just created.
		schemaFor: schemaResolver(treeDir, readStudioConfig(treeDir).studio ?? {}, (rel) => drafts.read(rel)),
	};
}

// "Add a site": GitHub's page to install the App on more repositories. The
// renderer refreshes the list when the window comes back to the front.
ipcMain.handle('sites:add', () => shell.openExternal(INSTALL_URL));

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
	const drafts = createDrafts(dir, treeDir);
	if (!site.local) drafts.tidy();
	current?.preview.stop();
	const secrets = createSecrets(dir, safeStorage);
	const preview = createPreview({
		siteDir: dir,
		treeDir,
		drafts,
		cacheDir: path.join(userData, 'cache', 'npm'),
		onStatus: (status) => send('preview:status', status),
		// Read at each rebuild, so a key typed later or a resync's new scope applies.
		secretsFile: () => {
			const spec = current?.scope.secrets;
			return spec ? { rel: spec.file, text: secrets.file(spec)?.text ?? null } : null;
		},
	});
	// Every change to the drafts reaches the preview copy (batched).
	let pendingRefresh = null;
	for (const method of ['save', 'remove', 'discard']) {
		const original = drafts[method];
		drafts[method] = function (...args) {
			const result = original.apply(this, args);
			clearTimeout(pendingRefresh);
			pendingRefresh = setTimeout(() => preview.refresh(), 50);
			return result;
		};
	}
	// Git LFS: uploads on publish, and the real bytes of a file shown in the app.
	const lfs = site.local ? null : createLfs(gh.token, site.fullName);
	const lfsStore = createLfsStore(path.join(dir, 'lfs'), lfs, site.branch);
	current = { site, dir, treeDir, drafts, preview, secrets, lfs, lfsStore, ...loadScope(treeDir, drafts) };
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

// Background sync of the open site (the renderer calls it every few minutes
// and when the window regains focus): several people may edit one site. When
// the branch moved, the scope, the schemas, and the preview follow; the
// client's changes stay as they are. Never throws: GitHub out of reach just
// means "offline" until the next try.
let syncing = null;
ipcMain.handle('site:sync', () => (syncing ??= resync().finally(() => { syncing = null; })));

async function resync() {
	const open = current;
	if (!open || open.site.local) return { status: 'ready', changed: false };
	let result;
	try {
		result = await syncSite(gh, open.site, open.dir);
	} catch {
		return { status: 'offline', changed: false };
	}
	if (open !== current || !result.changed) return { status: 'ready', changed: false };
	open.drafts.tidy();
	Object.assign(open, loadScope(open.treeDir, open.drafts));
	schemas.clear();
	open.preview.resync();
	return {
		status: 'ready',
		changed: true,
		scope: open.scope,
		changes: changes(),
		outdated: open.drafts.outdated(),
	};
}

const editable = (rel) => {
	if (!current || typeof rel !== 'string') throw new Error('Not editable.');
	if (!inScope(current.scope, rel) && !current.collections.contains(rel)) throw new Error('Not editable.');
	return rel;
};

// The client's current text of a file: their draft if any, else the synced one.
// `outdated`: someone else published this file since the client's change began.
ipcMain.handle('site:read', (_event, rel) => ({
	text: current.drafts.read(editable(rel)).toString('utf8'),
	changed: current.drafts.has(rel),
	outdated: current.drafts.outdated().includes(rel),
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

// --- Preview ---------------------------------------------------------------

// Starts the live preview of the open site; resolves to its URL, or to
// { error } with a code the renderer explains (noLockfile, offline, build…).
ipcMain.handle('preview:start', async () => {
	try {
		return { url: await current.preview.start() };
	} catch (error) {
		console.warn(`Kiri Studio: preview failed: ${error.message}
${error.log ?? ''}`);
		return { error: error.code ?? 'failed', message: error.message };
	}
});

ipcMain.handle('preview:stop', () => current?.preview.stop());

// --- Site keys (studio.secrets) ----------------------------------------------

// What the site asks for and whether each key is set; never the values.
ipcMain.handle('secrets:list', () => (current ? current.secrets.list(current.scope.secrets) : []));

// Saves one key (empty: removes it). A running preview gets the new file right
// away: the next script run uses it.
ipcMain.handle('secrets:set', (_event, name, value) => {
	if (typeof name !== 'string' || (value !== null && typeof value !== 'string')) throw new Error('Text expected.');
	current.secrets.set(current.scope.secrets, name, value ?? '');
	current.preview.writeSecrets();
	return current.secrets.list(current.scope.secrets);
});

// --- Collections -----------------------------------------------------------

ipcMain.handle('collection:files', (_event, pattern) => current.collections.files(pattern));

ipcMain.handle('collection:create', (_event, pattern, title, parent = null) => ({
	path: current.collections.create(pattern, String(title), typeof parent === 'string' ? parent : null),
	changes: changes(),
}));

ipcMain.handle('collection:delete', (_event, rel) => {
	current.collections.delete(editable(rel));
	return { changes: changes() };
});

// --- Publish -------------------------------------------------------------------

// Publishes the client's changes as one commit, then follows the site's build
// until it is online. Progress reaches the renderer through 'publish:status';
// the answer carries the refreshed scope, like a sync that changed things.
let publishing = null;
ipcMain.handle('publish:run', () => (publishing ??= runPublish().finally(() => { publishing = null; })));

async function runPublish() {
	const open = current;
	const say = (status) => send('publish:status', { site: open.site.fullName, ...status });
	if (process.env.KIRI_STUDIO_FAKE_PUBLISH) return fakePublish(open, say);
	if (open.site.local) return { error: 'notAvailable', changes: changes() };
	try {
		// What the preview's scripts produced (geocoding cache, fetched logos…)
		// goes out with the client's changes; without a finished preview, the
		// site's own build does that work after the publish.
		if (open.scope.publish.length && open.preview.idle) {
			takeGenerated({ previewDir: open.preview.dir, patterns: open.scope.publish, drafts: open.drafts });
		}
		const result = await publishSite({
			gh,
			lfs: { upload: (items, branch) => open.lfs.upload(items, branch), remember: open.lfsStore.remember },
			site: open.site,
			siteDir: open.dir,
			treeDir: open.treeDir,
			drafts: open.drafts,
			message: (work) => describeChanges(work, open.scope),
			onStatus: say,
		});
		// The synced copy is now the commit just made.
		open.drafts.tidy();
		Object.assign(open, loadScope(open.treeDir, open.drafts));
		schemas.clear();
		open.preview.resync();
		if (result.published) {
			watchDeploy({ gh, site: open.site, sha: result.sha, onStatus: say, isCancelled: () => current !== open })
				.catch(() => say({ state: 'published' }));
		}
		return { published: result.published, scope: open.scope, changes: changes(), outdated: open.drafts.outdated() };
	} catch (error) {
		console.warn(`Kiri Studio: publish failed: ${error.message}`);
		return { error: error.code ?? 'failed', message: error.message, changes: changes() };
	}
}

// Smoke tests (KIRI_STUDIO_FAKE_PUBLISH=<ms per step>): the same statuses, no GitHub.
async function fakePublish(open, say) {
	const pause = () => new Promise((resolve) => setTimeout(resolve, Number(process.env.KIRI_STUDIO_FAKE_PUBLISH) || 1));
	const work = open.drafts.list();
	say({ state: 'checking' }); await pause();
	say({ state: 'uploading', done: 1, total: 2 }); await pause();
	say({ state: 'committing' }); await pause();
	open.drafts.forget(work);
	say({ state: 'deploying' }); await pause();
	setTimeout(() => say({ state: 'online', url: null }), Number(process.env.KIRI_STUDIO_FAKE_PUBLISH) || 1);
	return { published: true, scope: open.scope, changes: changes(), outdated: [] };
}

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
	'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
	'.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
	'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
};
// `stream`: Electron's privilege for a scheme that serves audio and video. Playback
// also worked without it on the small smoke files; it is kept as documented.
protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true, stream: true } }]);
async function serveMedia(request) {
	const rel = decodeURIComponent(new URL(request.url).pathname.slice(1));
	if (!current || !mediaRootOf(current.scope, rel)) return new Response(null, { status: 404 });
	let data = current.drafts.read(rel);
	if (!data) return new Response(null, { status: 404 });
	// A file kept in Git LFS is synced as a pointer: show the real bytes.
	const pointer = parsePointer(data);
	if (pointer) {
		try {
			data = await current.lfsStore.resolve(pointer);
		} catch (error) {
			console.warn(`Kiri Studio: LFS file ${rel} unavailable: ${error.message}`);
			return new Response(null, { status: 502 });
		}
	}
	// Range requests are what lets the viewer jump around in an audio or video file.
	const response = bytesResponse(Buffer.from(data), {
		'Content-Type': MIME[path.posix.extname(rel).toLowerCase()] ?? 'application/octet-stream',
		// An SVG must not run scripts inside the app.
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
	}, request.headers.get('range'));
	// Smoke tests read this: a small file plays and seeks even without Range, so
	// only the answers themselves prove the protocol negotiates it.
	if (process.env.KIRI_STUDIO_SCREENSHOT) console.log(`[studio-media] ${response.status} ${rel} ${request.headers.get('range') ?? ''}`);
	return response;
}

ipcMain.handle('site:openLive', () => {
	if (current?.site.url) shell.openExternal(current.site.url);
});

// Smoke tests: capture the window once the renderer reports the wanted screen.
ipcMain.on('ui:settled', async (_event, screen) => {
	const file = process.env.KIRI_STUDIO_SCREENSHOT;
	if (!file || screen !== (process.env.KIRI_STUDIO_SMOKE_SCREEN || 'workspace')) return;
	// The first capture can fail while a virtual display's compositor starts
	// (UnknownVizError under xvfb): retry a few times.
	for (let attempt = 1; attempt <= 3; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
		try {
			fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
			app.exit(0);
			return;
		} catch (error) {
			console.warn(`Kiri Studio: screenshot attempt ${attempt} failed: ${error.message}`);
		}
	}
	app.exit(1);
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
		// Linux takes the window icon from here; Windows and macOS from the app.
		icon: path.join(import.meta.dirname, '..', '..', 'resources', 'icon.png'),
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

// The version that ran last time: a different one means the app just updated
// itself. Remembered right away, so the note shows on one launch only.
let updatedFrom = null;

// A new version being downloaded or ready to install (see updates.js); asked
// for once by the renderer, then pushed through 'update:status'. Smoke tests
// can fake one: KIRI_STUDIO_SMOKE_UPDATE=<percent> or "ready".
const fakeUpdate = process.env.KIRI_STUDIO_SMOKE_UPDATE;
let updateStatus = !fakeUpdate ? null
	: fakeUpdate === 'ready' ? { state: 'ready', version: '9.9.9' }
		: { state: 'downloading', version: '9.9.9', percent: Number(fakeUpdate) };
ipcMain.handle('update:status', () => updateStatus);
ipcMain.handle('update:install', () => { if (updateStatus?.state === 'ready') installUpdate(); });

// One Studio at a time: two instances fight over the same cache, preview
// folders and drafts (EPERM, "Unable to create cache"). A second launch tells
// the person, wakes the first window up and quits. Smoke tests are exempt.
const firstInstance = process.env.KIRI_STUDIO_SCREENSHOT || app.requestSingleInstanceLock();
if (!firstInstance) {
	const fr = app.getLocale().startsWith('fr');
	dialog.showErrorBox(
		'Kiri Studio',
		fr
			? 'Kiri Studio est déjà ouvert. Utilisez la fenêtre existante (vérifiez aussi le Gestionnaire des tâches si vous ne la voyez pas).'
			: 'Kiri Studio is already running. Use the existing window (also check the Task Manager if you cannot see it).',
	);
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});
}

if (firstInstance) app.whenReady().then(() => {
	const { lastVersion } = readPrefs();
	if (lastVersion && lastVersion !== app.getVersion()) updatedFrom = lastVersion;
	if (lastVersion !== app.getVersion()) writePrefs({ lastVersion: app.getVersion() });
	protocol.handle('studio-media', serveMedia);
	createWindow();
	if (process.env.KIRI_STUDIO_SCREENSHOT) setTimeout(() => app.exit(1), 120_000);
	else startUpdates((status) => { updateStatus = status; send('update:status', status); });
});
app.on('window-all-closed', () => app.quit());
