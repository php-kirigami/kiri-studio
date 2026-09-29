// Kiri Studio renderer: sign-in → site picker → workspace. Plain DOM, no
// framework. Every string shown to the client goes through t(); data from
// GitHub or the site is only ever set as text, never as HTML.
import { fileCount, setLocale, t } from './i18n.js';

const { studio } = window;
const app = document.getElementById('app');

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

async function showSites(user, { pick = false } = {}) {
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

	show('workspace-loading', h('div.workspace',
		topbar(user, site, sites),
		sidebar,
		main,
		h('footer.statusbar', status)));

	let opened;
	try {
		opened = await studio.site.open(site);
	} catch (error) {
		stopListening();
		return showError(error, () => openSite(user, site, sites));
	}
	stopListening();
	setStatus(opened.status);

	const select = (button, render) => {
		sidebar.querySelectorAll('[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
		button.setAttribute('aria-current', 'true');
		render();
	};

	const entryButton = (entry) => {
		const button = h('button.entry', { dataset: { kind: entry.kind, path: entry.path } }, entry.label);
		button.addEventListener('click', () => select(button, () => showEntry(main, entry)));
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
	sidebar.replaceChildren(...[
		h('section.group',
			h('h2', t('ws.pages')),
			h('ul', scope.content.map((entry) => h('li', entryButton(entry))))),
		scope.collections.map((collection) => h('section.group',
			h('h2', collection.label),
			h('ul', collection.files.map((entry) => h('li', entryButton(entry)))))),
		mediaSection(t('ws.images'), scope.images),
		mediaSection(t('ws.files'), scope.files),
	].flat().filter(Boolean));

	main.replaceChildren(h('p.empty', t('ws.empty')));
	studio.ui.settled('workspace');

	if (info.smokeOpen) {
		const entry = [...scope.content, ...scope.collections.flatMap((c) => c.files)].find((e) => e.path === info.smokeOpen);
		const button = sidebar.querySelector(`[data-path="${CSS.escape(info.smokeOpen)}"]`);
		if (entry && button) select(button, () => showEntry(main, entry).then(() => studio.ui.settled('entry')));
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
		h('button.primary', { disabled: true, title: t('ws.readOnly') }, t('ws.publish')),
		h('details.account',
			h('summary', h('img.avatar', { src: user.avatar, alt: '' }), h('span', user.name)),
			h('div.menu', h('button.link', { onclick: signOut }, t('ws.signOut')))));
}

async function showEntry(main, entry) {
	main.replaceChildren(h('p.empty', t('loading')));
	try {
		const text = await studio.site.read(entry.path);
		main.replaceChildren(
			h('h1', entry.label),
			h('p.notice', t('ws.readOnly')),
			h('pre.source', text));
	} catch (error) {
		main.replaceChildren(h('p.notice', errorMessage(error)));
	}
}

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
