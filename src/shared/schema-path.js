// Walking a JSON Schema along a data path, shared by the main process (error
// messages) and the renderer (completion, hover). Path segments are object
// keys, or '*' for "any item of a list". Only what editing help needs is
// supported: local $refs, properties, items, additionalProperties, and the
// branches of allOf/anyOf/oneOf.

export function deref(root, schema) {
	const seen = new Set();
	while (schema && typeof schema.$ref === 'string' && schema.$ref.startsWith('#') && !seen.has(schema.$ref)) {
		seen.add(schema.$ref);
		schema = schema.$ref.slice(1).split('/').slice(1)
			.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
			.reduce((node, key) => node?.[key], root);
	}
	return schema && typeof schema === 'object' ? schema : null;
}

// The schema itself plus its allOf/anyOf/oneOf branches, dereferenced.
function variants(root, schema) {
	const self = deref(root, schema);
	if (!self) return [];
	return [self, ...['allOf', 'anyOf', 'oneOf'].flatMap((key) => (self[key] ?? []).flatMap((branch) => variants(root, branch)))];
}

export function schemaAt(root, path) {
	let schema = root;
	for (const segment of path) {
		const options = variants(root, schema);
		let next = null;
		for (const option of options) {
			if (segment === '*') next = option.items && !Array.isArray(option.items) ? option.items : null;
			else next = option.properties?.[segment] ?? null;
			if (next) break;
		}
		if (!next && segment !== '*') {
			next = options.find((option) => option.additionalProperties && typeof option.additionalProperties === 'object')?.additionalProperties ?? null;
		}
		schema = deref(root, next);
		if (!schema) return null;
	}
	return deref(root, schema);
}

// { name: { schema, required } } for an object schema, across its variants.
export function propertiesOf(root, schema) {
	const out = {};
	for (const option of variants(root, schema)) {
		const required = new Set(option.required ?? []);
		for (const [name, sub] of Object.entries(option.properties ?? {})) {
			out[name] ??= { schema: deref(root, sub) ?? {}, required: false };
			if (required.has(name)) out[name].required = true;
		}
	}
	return out;
}

// The JSON type a schema expects, looking through variants: 'object',
// 'array', 'string', … or null.
export function typeOf(root, schema) {
	for (const option of variants(root, schema)) {
		const type = Array.isArray(option.type) ? option.type[0] : option.type;
		if (type) return type;
		if (option.properties) return 'object';
		if (option.items) return 'array';
	}
	return null;
}
