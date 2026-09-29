// Kiri Studio renderer: sign-in → site picker → workspace. Plain DOM, no
// framework. Every string shown to the client goes through t(); data from
// GitHub or the site is only ever set as text, never as HTML.
import { changeCount, setLocale, t } from './i18n.js';
import { actions, createMarkdownEditor, insertBlock } from './markdown-editor.js';
import { createDataEditor } from './data-editor.js';
import { h } from './dom.js';
import { ask, imageCode, pickImage, showMedia } from './media-view.js';
import { createPreviewPane } from './preview-pane.js';

const { studio } = window;
const app = document.getElementById('app');

let ws = null; // the open workspace, see openSite()

const SYNC_EVERY = 3 * 60_000;         // background check for a new version
const SYNC_ON_FOCUS_AFTER = 30_000;    // back to the window: check if older than this

function show(screen, ...content) {
	app.dataset.screen = screen;
	app.replaceChildren(...content);
	studio.ui.settled(screen);
}

const errorMessage = (error) => (/network|fetch|ENOTFOUND|offline/i.test(String(error?.message)) ? t('error.offline') : t('error.generic'));

function showError(error, retry) {
	show('error', h('main.center',
		h('section.card',
			h('p.lead', errorMessage(error)),
			h('button.primary', { onclick: retry }, t('error.retry')))));
}

// --- Sign-in ---------------------------------------------------------------

function showSignIn(message) {
	show('signin', h('main.center',
		h('section.card.welcome',
			h('div.brand', 'Kiri Studio'),
			h('h1', t('signin.title')),
			message && h('p.notice', message),
			h('p.lead', t('signin.lead')),
			h('button.primary.large.github', { onclick: startSignIn }, t('signin.button')))));
}

async function startSignIn() {
	let code;
	try {
		code = await studio.auth.start();
	} catch (error) {
		return showError(error, () => showSignIn());
	}
	show('signin-code', h('main.center',
		h('section.card.welcome',
			h('h1', t('signin.codeTitle')),
			h('p.lead', t('signin.codeLead')),
			h('p.code', { 'aria-label': code.userCode }, code.userCode),
			h('p.waiting', t('signin.waiting')),
			h('button.link', { onclick: () => studio.auth.reopen() }, t('signin.reopen')))));
}

studio.auth.onChange((state) => {
	if (state.signedIn) return showSites(state.user);
	const messages = { expired: t('signin.expired'), denied: t('signin.denied') };
	showSignIn(messages[state.error] ?? t('signin.failed'));
});

// --- Sites -----------------------------------------------------------------

// Leaving the workspace: save what's being typed first.
async function leaveWorkspace() {
	ws?.stopSync?.();
	await ws?.close();
	if (ws?.preview) {
		ws.preview.close();
		await studio.preview.stop();
	}
	ws = null;
}

async function showSites(user, { pick = false } = {}) {
	await leaveWorkspace();
	show('loading', h('main.center', h('p.waiting', t('loading'))));
	let list;
	try {
		list = await studio.sites.list();
	} catch (error) {
		return showError(error, () => showSites(user));
	}
	const { sites, lastSite } = list;

	if (!sites.length) {
		return show('sites', h('main.center',
			h('section.card',
				h('h1', t('sites.title')),
				h('p.lead', t('sites.none')),
				h('div.actions',
					h('button.primary', { onclick: () => showSites(user) }, t('sites.refresh')),
					h('button.link', { onclick: signOut }, t('ws.signOut'))))));
	}

	// Seamless path: reopen the last site, or the only one.
	if (!pick) {
		const direct = sites.find((site) => site.fullName === lastSite) ?? (sites.length === 1 ? sites[0] : null);
		if (direct) return openSite(user, direct, sites);
	}

	show('sites', h('main.center',
		h('section.card',
			h('h1', t('sites.title')),
			h('p.lead', t('sites.lead')),
			h('ul.site-list', sites.map((site) =>
				h('li', h('button.site', { onclick: () => openSite(user, site, sites) },
					h('span.site-title', site.title),
					site.url && h('span.site-url', site.url.replace(/^https?:\/\//, '')))))))));
}

async function signOut() {
	await leaveWorkspace();
	await studio.auth.signOut();
	showSignIn();
}

// --- Workspace -------------------------------------------------------------

async function openSite(user, site, sites) {
	const status = h('span.sync', { dataset: { state: 'checking' } }, t('sync.checking'));
	const setStatus = (state, text = t(`sync.${state}`)) => {
		status.dataset.state = state;
		status.textContent = text;
	};
	const stopListening = studio.site.onSync((step) => setStatus(step));

	const sidebar = h('nav.sidebar', { 'aria-label': t('ws.pages') });
	const main = h('main.editor', h('p.empty', t('sync.downloading')));
	const changesLabel = h('span.changes');

	await leaveWorkspace();
	const layout = h('div.workspace',
		topbar(user, site, sites),
		sidebar,
		main,
		h('footer.statusbar', status, changesLabel));
	show('workspace-loading', layout);

	let opened;
	try {
		opened = await studio.site.open(site);
	} catch (error) {
		stopListening();
		return showError(error, () => openSite(user, site, sites));
	}
	stopListening();
	setStatus(opened.status);

	ws = {
		scope: opened.scope,
		main,
		sidebar,
		changes: new Set(opened.changes),
		outdated: new Set(), // changed files someone else published since (after a sync)
		closeView: null, // flushes and tears down the open editor, if any
		view: null,      // the open editor or media manager: { synced() } after a sync
		async close() {
			await this.closeView?.();
			this.closeView = null;
			this.view = null;
		},
		setChanges(paths) {
			this.changes = new Set(paths);
			for (const button of sidebar.querySelectorAll('[data-path]')) {
				button.toggleAttribute('data-changed', this.changes.has(button.dataset.path));
			}
			changesLabel.textContent = this.changes.size ? changeCount(this.changes.size) : '';
		},
	};

	const select = async (button, render) => {
		await ws.close();
		sidebar.querySelectorAll('[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
		button.setAttribute('aria-current', 'true');
		return render();
	};

	const entryButton = (entry) => {
		const button = h('button.entry', { dataset: { kind: entry.kind, path: entry.path } }, entry.label);
		button.addEventListener('click', () => select(button, () => showEntry(entry)));
		return button;
	};

	// A collection lists its files live (new and deleted ones included); when
	// it allows it, "+" creates a file from a title and opens it.
	let loading = [];
	const collectionSection = (collection) => {
		const list = h('ul');
		const render = async (open) => {
			const files = await studio.collections.files(collection.pattern);
			list.replaceChildren(...files.map((entry) => h('li', entryButton(entry))));
			ws.setChanges([...ws.changes]);
			if (open) list.querySelector(`[data-path="${CSS.escape(open)}"]`)?.click();
		};
		const add = collection.creatable && h('button.add', {
			title: t('collection.new'),
			'aria-label': t('collection.new'),
			onclick: async () => {
				const title = await ask(t('collection.newTitle'));
				if (!title) return;
				const created = await studio.collections.create(collection.pattern, title);
				ws.setChanges(created.changes);
				render(created.path);
			},
		});
		ws.collections.set(collection.pattern, { ...collection, render });
		loading.push(render());
		return h('section.group', h('div.group-head', h('h2', collection.label), add), list);
	};

	// One entry per media folder; subfolders are browsed in the main area.
	const mediaSection = (title, root, kind) => {
		if (!root) return null;
		const button = h('button.entry.folder', { dataset: { media: kind } }, h('span', title));
		button.addEventListener('click', () => select(button, () => showMedia(ws, { root, title, kind })));
		return h('li', button);
	};
	// Built on open and again whenever a sync brings a new version of the
	// site; the highlighted entry stays highlighted.
	async function renderSidebar(scope) {
		const selected = sidebar.querySelector('[aria-current]');
		const key = selected && (selected.dataset.path ? `[data-path="${CSS.escape(selected.dataset.path)}"]` : `[data-media="${selected.dataset.media}"]`);
		ws.collections = new Map();
		loading = [];
		const mediaGroup = [
			mediaSection(t('ws.images'), scope.images?.path, 'images'),
			mediaSection(t('ws.files'), scope.files?.path, 'files'),
		].filter(Boolean);

		// Content grouped by the page it belongs to, in discovery order.
		const groups = new Map();
		for (const entry of scope.content) {
			const name = entry.group ?? t('ws.other');
			if (!groups.has(name)) groups.set(name, []);
			groups.get(name).push(entry);
		}

		sidebar.replaceChildren(...[
			[...groups].map(([name, entries]) => h('section.group',
				h('h2', name),
				h('ul', entries.map((entry) => h('li', entryButton(entry)))))),
			scope.collections.map((collection) => collectionSection(collection)),
			mediaGroup.length && h('section.group', h('h2', t('ws.media')), h('ul', mediaGroup)),
		].flat().filter(Boolean));
		await Promise.all(loading);
		if (key) sidebar.querySelector(key)?.setAttribute('aria-current', 'true');
		ws.setChanges([...ws.changes]);
	}

	main.replaceChildren(h('p.empty', t('ws.empty')));
	await renderSidebar(opened.scope);

	// Someone else may publish while the client works: look for a new version
	// every few minutes and when the window comes back to the front.
	const mine = ws;
	let lastSync = Date.now();
	async function syncNow() {
		lastSync = Date.now();
		const result = await studio.site.sync();
		if (ws !== mine) return;
		setStatus(result.status);
		if (!result.changed) return;
		ws.scope = result.scope;
		ws.outdated = new Set(result.outdated);
		ws.setChanges(result.changes);
		await renderSidebar(result.scope);
		await ws.view?.synced();
	}
	const timer = setInterval(syncNow, SYNC_EVERY);
	const onFocus = () => { if (Date.now() - lastSync > SYNC_ON_FOCUS_AFTER) syncNow(); };
	window.addEventListener('focus', onFocus);
	ws.stopSync = () => {
		clearInterval(timer);
		window.removeEventListener('focus', onFocus);
	};

	// Live preview, next to the editor; its button sits in the top bar.
	ws.preview = createPreviewPane(ws, layout);
	layout.append(ws.preview.pane);
	layout.querySelector('.topbar .spacer').after(ws.preview.toggle);
	ws.preview.init();
	studio.ui.settled('workspace');

	// Smoke tests: open a media manager ("media:images") and add files to it.
	if (info.smokeOpen?.startsWith('media:')) {
		const button = sidebar.querySelector(`[data-media="${info.smokeOpen.slice(6)}"]`);
		if (button) {
			button.click();
			// The manager is ready once it registered its smoke hooks.
			while (!ws.smokeAdd) await new Promise((resolve) => setTimeout(resolve, 100));
			if (info.smokeFiles?.length) {
				await ws.smokeAdd(info.smokeFiles.map((f) => new File([f.bytes], f.name, { type: f.type })));
			}
			await new Promise((resolve) => setTimeout(resolve, 800)); // thumbnails
			if (info.smokeView) {
				ws.smokeView();
				await new Promise((resolve) => setTimeout(resolve, 600));
			}
			studio.ui.settled('entry');
		}
	} else if (info.smokeOpen) {
		const { scope } = opened;
		const entry = [...scope.content, ...scope.collections.flatMap((c) => c.files)].find((e) => e.path === info.smokeOpen);
		const button = sidebar.querySelector(`[data-path="${CSS.escape(info.smokeOpen)}"]`);
		if (entry && button) {
			await select(button, () => showEntry(entry));
			if (info.smokePreview) {
				await ws.preview.ready();
				await new Promise((resolve) => setTimeout(resolve, 2000)); // page load
			}
			if (info.smokeType) {
				await ws.smokeType?.(info.smokeType);
				await new Promise((resolve) => setTimeout(resolve, 1200)); // let the checks run
				ws.showProblems?.();
			}
			studio.ui.settled('entry');
		}
	}
}

function topbar(user, site, sites) {
	return h('header.topbar',
		h('div.brand', 'Kiri Studio'),
		h('div.site-name',
			h('span', site.title),
			sites.length > 1 && h('button.link', { onclick: () => showSites(user, { pick: true }) }, t('ws.switch'))),
		h('div.spacer'),
		site.url && h('button.secondary', { onclick: () => studio.site.openLive() }, t('ws.viewSite')),
		h('button.primary', { disabled: true, title: t('ws.publishSoon') }, t('ws.publish')),
		h('details.account',
			h('summary', user.avatar ? h('img.avatar', { src: user.avatar, alt: '' }) : h('span.avatar.initial', { 'aria-hidden': 'true' }, user.name[0]), h('span', user.name)),
			h('div.menu', h('button.link', { onclick: signOut }, t('ws.signOut')))));
}

async function showEntry(entry) {
	const { main } = ws;
	ws.preview?.navigate(entry);
	main.replaceChildren(h('p.empty', t('loading')));
	let file;
	try {
		file = await studio.site.read(entry.path);
	} catch (error) {
		return main.replaceChildren(h('p.notice', errorMessage(error)));
	}

	// Autosave: every change is written as a draft half a second after typing
	// stops, and immediately when leaving the file or closing the app.
	const saveState = h('span.save-state');
	const discard = h('button.link.discard', { hidden: !ws.changes.has(entry.path) }, t('editor.discard'));

	// Files of a collection that allows it can be deleted.
	const collection = [...ws.collections.values()].find((c) => c.creatable && pathMatches(entry.path, c.pattern));
	const remove = collection && h('button.link.danger', {
		onclick: async () => {
			if (!confirm(t('collection.deleteConfirm', { label: entry.label }))) return;
			clearTimeout(timer);
			pending = null;
			editor.destroy();
			ws.closeView = null;
			ws.view = null;
			ws.setChanges((await studio.collections.delete(entry.path)).changes);
			ws.main.replaceChildren(h('p.empty', t('ws.empty')));
			collection.render();
		},
	}, t('collection.delete'));
	const setSaveState = (state) => {
		saveState.dataset.state = state;
		saveState.textContent = state ? t(`editor.${state}`) : '';
	};
	let pending = null;
	let timer = null;
	const flush = async () => {
		clearTimeout(timer);
		if (pending === null) return;
		const text = pending;
		pending = null;
		ws.setChanges(await studio.drafts.save(entry.path, text));
		discard.hidden = !ws.changes.has(entry.path);
		if (pending === null) setSaveState('saved');
	};

	const onChange = (text) => {
		pending = text;
		setSaveState('saving');
		clearTimeout(timer);
		timer = setTimeout(flush, 500);
	};

	const isMarkdown = entry.kind === 'markdown';
	const surface = h(isMarkdown ? 'div.md-surface' : 'div.data-surface');
	let editor;
	let help = null;
	if (isMarkdown) {
		editor = createMarkdownEditor(surface, { text: file.text, onChange });
	} else {
		const schema = await studio.data.schema(entry.path);
		const problems = h('button.problems', { dataset: { count: '0' } });
		editor = createDataEditor(surface, {
			text: file.text,
			format: /\.json$/i.test(entry.path) ? 'json' : 'yaml',
			schema,
			check: (text) => studio.data.check(entry.path, text),
			message: checkMessage,
			onChange,
			onProblems(count) {
				problems.dataset.count = String(count);
				problems.textContent = count === 0 ? t('check.none') : count === 1 ? t('check.one') : t('check.many', { count });
			},
			labels: { required: t('check.requiredLabel') },
		});
		problems.addEventListener('click', () => editor.showProblems());
		help = h('div.help',
			h('p', schema ? t('editor.schemaHelp') : t('editor.noSchemaHelp')),
			problems);
	}

	const tool = (action, label, key) => h('button.tool', {
		dataset: { action },
		title: key ? `${label} (${key})` : label,
		'aria-label': label,
		onclick: () => (action === 'image' ? insertImage(editor.view) : actions[action](editor.view)),
	});

	discard.addEventListener('click', async () => {
		if (!confirm(t('editor.discardConfirm', { label: entry.label }))) return;
		clearTimeout(timer);
		pending = null;
		editor.destroy();
		ws.closeView = null;
		ws.setChanges(await studio.drafts.discard(entry.path));
		showEntry(entry);
	});

	ws.closeView = async () => {
		await flush();
		editor.destroy();
	};
	// After a sync brought a new version of the site: an untouched file shows
	// the new text; one the client changed keeps their text, and says so if
	// someone else published it in the meantime (theirs wins on publish).
	const outdated = h('p.notice.outdated', { hidden: !file.outdated }, t('editor.outdated'));
	const untouched = () => pending === null && !ws.changes.has(entry.path) && editor.view.state.doc.toString() === file.text;
	const view = {
		async synced() {
			if (!untouched()) {
				outdated.hidden = !ws.outdated.has(entry.path);
				return;
			}
			const stillThere = ws.sidebar.querySelector(`[data-path="${CSS.escape(entry.path)}"]`);
			const fresh = stillThere && await studio.site.read(entry.path).catch(() => null);
			if (ws.view !== view || !untouched() || fresh?.text === file.text) return;
			editor.destroy();
			ws.closeView = null;
			ws.view = null;
			if (fresh) showEntry(entry);
			else main.replaceChildren(h('p.empty', t('ws.empty')));
		},
	};
	ws.view = view;
	ws.showProblems = editor.showProblems;
	ws.smokeType = async (text) => {
		const { view } = editor;
		view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
		await flush();
	};

	const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';
	main.replaceChildren(...[
		h('div.entry-head', h('h1', entry.label), saveState, discard, remove),
		outdated,
		isMarkdown && h('div.toolbar', { role: 'toolbar' },
			tool('heading', t('editor.heading')),
			tool('subheading', t('editor.subheading')),
			h('span.sep'),
			tool('bold', t('editor.bold'), `${mod}B`),
			tool('italic', t('editor.italic'), `${mod}I`),
			tool('link', t('editor.link'), `${mod}K`),
			ws.scope.images && tool('image', t('editor.image')),
			h('span.sep'),
			tool('bullets', t('editor.bullets')),
			tool('numbers', t('editor.numbers')),
			tool('quote', t('editor.quote'))),
		help,
		surface,
	].filter(Boolean));
	editor.focus();
}

// The toolbar's Image button: pick one, insert its {% img-asset %} code.
async function insertImage(view) {
	const rel = await pickImage(ws);
	if (rel) insertBlock(view, imageCode(ws.scope, rel));
	else view.focus();
}

// "src/blog/post.md" against "src/blog/*.md" — enough glob for collection
// patterns in the renderer (the main process decides what is allowed).
function pathMatches(rel, pattern) {
	const re = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
	return new RegExp(`^${re}$`).test(rel);
}

// Plain-language text for a data-file diagnostic from the main process.
function checkMessage({ key, params }) {
	const text = t(key, params);
	return params.description ? `${text}\n${params.description}` : text;
}

// Closing the app: save what's being typed before the window goes away.
studio.ui.onBeforeClose(async () => {
	await ws?.close();
	studio.ui.readyToClose();
});

// --- Start -----------------------------------------------------------------

let info = {};

async function start() {
	info = await studio.info();
	setLocale(info.locale);
	show('loading', h('main.center', h('p.waiting', t('loading'))));
	const auth = await studio.auth.status();
	if (auth.signedIn) showSites(auth.user);
	else if (auth.offline) showError(new Error('offline'), start);
	else showSignIn();
}

start();
