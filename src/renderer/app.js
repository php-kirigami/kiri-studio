// Kiri Studio renderer: sign-in → site picker → workspace. Plain DOM, no
// framework. Every string shown to the client goes through t(); data from
// GitHub or the site is only ever set as text, never as HTML.
import { changeCount, fileCount, setLocale, t } from './i18n.js';
import { actions, createMarkdownEditor } from './markdown-editor.js';
import { createDataEditor } from './data-editor.js';

const { studio } = window;
const app = document.getElementById('app');

let ws = null; // the open workspace, see openSite()

// h('button.primary', { onclick }, 'Label') → element. The props object is
// optional; children may be strings, elements, arrays, or null/false.
function h(spec, props, ...children) {
	if (props == null || props === false || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
		children.unshift(props);
		props = {};
	}
	const [tag, ...classes] = spec.split('.');
	const el = document.createElement(tag || 'div');
	if (classes.length) el.className = classes.join(' ');
	for (const [key, value] of Object.entries(props)) {
		if (value == null || value === false) continue;
		if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
		else if (key === 'dataset') Object.assign(el.dataset, value);
		else el.setAttribute(key, value === true ? '' : value);
	}
	el.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
	return el;
}

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
	await ws?.close();
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
	show('workspace-loading', h('div.workspace',
		topbar(user, site, sites),
		sidebar,
		main,
		h('footer.statusbar', status, changesLabel)));

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
		main,
		sidebar,
		changes: new Set(opened.changes),
		closeView: null, // flushes and tears down the open editor, if any
		async close() {
			await this.closeView?.();
			this.closeView = null;
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

	const folderList = (node) => h('ul.folders', node.folders.map((folder) => {
		const button = h('button.entry.folder', {},
			h('span', folder.name),
			h('span.count', String(folder.files)));
		button.addEventListener('click', () => select(button, () => showFolder(main, folder)));
		return h('li', button, folder.folders.length ? folderList(folder) : null);
	}));

	const mediaSection = (title, node) => {
		if (!node) return null;
		const button = h('button.entry.folder', {}, h('span', t('ws.mainFolder')), h('span.count', String(node.files)));
		button.addEventListener('click', () => select(button, () => showFolder(main, node, title)));
		return h('section.group', h('h2', title), button, folderList(node));
	};

	const { scope } = opened;
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
		scope.collections.map((collection) => h('section.group',
			h('h2', collection.label),
			h('ul', collection.files.map((entry) => h('li', entryButton(entry)))))),
		mediaSection(t('ws.images'), scope.images),
		mediaSection(t('ws.files'), scope.files),
	].flat().filter(Boolean));
	ws.setChanges(opened.changes);

	main.replaceChildren(h('p.empty', t('ws.empty')));
	studio.ui.settled('workspace');

	if (info.smokeOpen) {
		const entry = [...scope.content, ...scope.collections.flatMap((c) => c.files)].find((e) => e.path === info.smokeOpen);
		const button = sidebar.querySelector(`[data-path="${CSS.escape(info.smokeOpen)}"]`);
		if (entry && button) {
			await select(button, () => showEntry(entry));
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
			h('summary', h('img.avatar', { src: user.avatar, alt: '' }), h('span', user.name)),
			h('div.menu', h('button.link', { onclick: signOut }, t('ws.signOut')))));
}

async function showEntry(entry) {
	const { main } = ws;
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
		onclick: () => actions[action](editor.view),
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
	ws.showProblems = editor.showProblems;
	ws.smokeType = async (text) => {
		const { view } = editor;
		view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
		await flush();
	};

	const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';
	main.replaceChildren(...[
		h('div.entry-head', h('h1', entry.label), saveState, discard),
		isMarkdown && h('div.toolbar', { role: 'toolbar' },
			tool('heading', t('editor.heading')),
			tool('subheading', t('editor.subheading')),
			h('span.sep'),
			tool('bold', t('editor.bold'), `${mod}B`),
			tool('italic', t('editor.italic'), `${mod}I`),
			tool('link', t('editor.link'), `${mod}K`),
			h('span.sep'),
			tool('bullets', t('editor.bullets')),
			tool('numbers', t('editor.numbers')),
			tool('quote', t('editor.quote'))),
		help,
		surface,
	].filter(Boolean));
	editor.focus();
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

function showFolder(main, folder, title = folder.name) {
	main.replaceChildren(
		h('h1', title),
		h('p.lead', folder.files ? fileCount(folder.files) : t('ws.folderEmpty')));
}

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
