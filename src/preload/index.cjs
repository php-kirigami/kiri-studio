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
	ui: {
		settled: (screen) => ipcRenderer.send('ui:settled', screen),
	},
});
