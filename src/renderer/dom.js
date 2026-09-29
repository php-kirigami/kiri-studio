// Tiny DOM builder shared by the renderer modules.

// h('button.primary', { onclick }, 'Label') → element. The props object is
// optional; children may be strings, elements, arrays, or null/false.
export function h(spec, props, ...children) {
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
