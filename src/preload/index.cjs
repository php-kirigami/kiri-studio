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
	auth: {
		status: () => ipcRenderer.invoke('auth:status'),
		start: () => ipcRenderer.invoke('auth:start'),
		reopen: () => ipcRenderer.invoke('auth:reopen'),
		signOut: () => ipcRenderer.invoke('auth:signOut'),
		onChange: listen('auth:changed'),
	},
	sites: {
		list: () => ipcRenderer.invoke('sites:list'),
	},
	site: {
		open: (site) => ipcRenderer.invoke('site:open', site),
		read: (path) => ipcRenderer.invoke('site:read', path),
		openLive: () => ipcRenderer.invoke('site:openLive'),
		onSync: listen('sync:status'),
	},
	data: {
		schema: (path) => ipcRenderer.invoke('data:schema', path),
		check: (path, text) => ipcRenderer.invoke('data:check', path, text),
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
