// The only bridge between the sandboxed renderer and the main process.
// CommonJS on purpose: sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
	const listener = (_event, data) => callback(data);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.off(channel, listener);
};

contextBridge.exposeInMainWorld('studio', {
	info: () => ipcRenderer.invoke('app:info'),
	copy: (text) => ipcRenderer.invoke('app:copy', text),
	openPreview: (url) => ipcRenderer.invoke('app:openPreview', url),
	updates: {
		status: () => ipcRenderer.invoke('update:status'),
		install: () => ipcRenderer.invoke('update:install'),
		onStatus: listen('update:status'),
	},
	auth: {
		status: () => ipcRenderer.invoke('auth:status'),
		start: () => ipcRenderer.invoke('auth:start'),
		reopen: () => ipcRenderer.invoke('auth:reopen'),
		signOut: () => ipcRenderer.invoke('auth:signOut'),
		onChange: listen('auth:changed'),
	},
	sites: {
		list: () => ipcRenderer.invoke('sites:list'),
		add: () => ipcRenderer.invoke('sites:add'),
	},
	site: {
		open: (site) => ipcRenderer.invoke('site:open', site),
		read: (path) => ipcRenderer.invoke('site:read', path),
		sync: () => ipcRenderer.invoke('site:sync'),
		openLive: () => ipcRenderer.invoke('site:openLive'),
		onSync: listen('sync:status'),
	},
	data: {
		schema: (path) => ipcRenderer.invoke('data:schema', path),
		check: (path, text) => ipcRenderer.invoke('data:check', path, text),
	},
	preview: {
		start: () => ipcRenderer.invoke('preview:start'),
		stop: () => ipcRenderer.invoke('preview:stop'),
		onStatus: listen('preview:status'),
	},
	collections: {
		files: (pattern) => ipcRenderer.invoke('collection:files', pattern),
		create: (pattern, title) => ipcRenderer.invoke('collection:create', pattern, title),
		delete: (path) => ipcRenderer.invoke('collection:delete', path),
	},
	media: {
		tree: (root) => ipcRenderer.invoke('media:tree', root),
		add: (folder, name, bytes) => ipcRenderer.invoke('media:add', folder, name, bytes),
		mkdir: (parent, name) => ipcRenderer.invoke('media:mkdir', parent, name),
		rename: (path, name) => ipcRenderer.invoke('media:rename', path, name),
		delete: (path) => ipcRenderer.invoke('media:delete', path),
		usage: (path) => ipcRenderer.invoke('media:usage', path),
	},
	publish: {
		run: () => ipcRenderer.invoke('publish:run'),
		onStatus: listen('publish:status'),
	},
	drafts: {
		save: (path, text) => ipcRenderer.invoke('drafts:save', path, text),
		discard: (path) => ipcRenderer.invoke('drafts:discard', path),
	},
	ui: {
		settled: (screen) => ipcRenderer.send('ui:settled', screen),
		onBeforeClose: listen('app:beforeClose'),
		readyToClose: () => ipcRenderer.send('app:readyToClose'),
	},
});
