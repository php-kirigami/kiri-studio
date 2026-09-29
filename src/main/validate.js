// Checks a YAML/JSON data file as the client types: syntax first, then the
// file's JSON Schema. Runs in the main process because Ajv compiles schemas
// to functions, which the renderer's CSP forbids.
//
// Diagnostics are { from, to, severity, key, params }: `key` is a message id
// the renderer translates (see i18n.js, "check.*"), so the wording stays
// plain and in the client's language. Positions come from the `yaml` parser,
// which keeps the source range of every node.
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { isMap, parseDocument } from 'yaml';
import { propertiesOf, schemaAt } from '../shared/schema-path.js';

const compiled = new WeakMap();

function compile(schema) {
	if (!compiled.has(schema)) {
		const draft = String(schema.$schema ?? '');
		const Engine = draft.includes('2020-12') ? Ajv2020 : draft.includes('2019-09') ? Ajv2019 : Ajv;
		const ajv = new Engine({ allErrors: true, strict: false, validateFormats: false, verbose: true });
		let validator;
		try {
			validator = ajv.compile(schema);
		} catch {
			validator = null; // a broken schema must not block editing
		}
		compiled.set(schema, validator);
	}
	return compiled.get(schema);
}

const SYNTAX_KEYS = {
	BAD_INDENT: 'check.indent',
	BAD_DIRECTIVE: 'check.syntax',
	DUPLICATE_KEY: 'check.duplicate',
	MISSING_CHAR: 'check.missingChar',
	MULTILINE_IMPLICIT_KEY: 'check.indent',
	TAB_AS_INDENT: 'check.tab',
	UNEXPECTED_TOKEN: 'check.syntax',
	BLOCK_AS_IMPLICIT_KEY: 'check.indent',
};

export function checkData(text, schema) {
	const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
	const lineEnd = (pos) => {
		const end = text.indexOf('\n', pos);
		return end === -1 ? text.length : end;
	};

	// One broken line makes the parser report many; only the first helps.
	const syntax = [...doc.errors.slice(0, 1), ...doc.warnings].map((error) => {
		const [from = 0, to = from] = error.pos ?? [];
		return {
			from,
			to: Math.max(to, from + 1) > text.length ? text.length : Math.max(to, from + 1),
			severity: doc.errors.includes(error) ? 'error' : 'warning',
			key: SYNTAX_KEYS[error.code] ?? 'check.syntax',
			params: {},
		};
	});
	if (doc.errors.length || !schema) return syntax;

	const validate = compile(schema);
	if (!validate) return syntax;
	const data = doc.toJS();
	if (validate(data)) return syntax;

	const diagnostics = [];
	const seen = new Set();
	for (const error of validate.errors) {
		if (['oneOf', 'anyOf', 'if', 'not'].includes(error.keyword)) continue; // their branches report the real cause
		const segments = error.instancePath.split('/').slice(1)
			.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
			.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
		const node = segments.length ? doc.getIn(segments, true) : doc.contents;
		const schemaPath = segments.map((part) => (typeof part === 'number' ? '*' : part));
		const field = segments.filter((part) => typeof part === 'string').at(-1) ?? null;
		// Description of property `name` of the object at `objectPath`.
		const describe = (name, objectPath = schemaPath) => {
			const parent = schemaAt(schema, objectPath);
			return (parent && propertiesOf(schema, parent)[name]?.schema.description) || null;
		};
		const ownDescription = () => (typeof segments.at(-1) === 'string' ? describe(segments.at(-1), schemaPath.slice(0, -1)) : null);

		let from = node?.range?.[0] ?? 0;
		let to = node?.range?.[1] ?? lineEnd(0);
		let key;
		let params = { field, value: error.params?.allowedValues?.join(', ') ?? '' };

		switch (error.keyword) {
			case 'required':
				// Point at the object's first line.
				to = lineEnd(from);
				key = 'check.required';
				params = { field: error.params.missingProperty, description: describe(error.params.missingProperty) };
				break;
			case 'additionalProperties': {
				const pair = isMap(node) && node.items.find((item) => String(item.key?.value) === error.params.additionalProperty);
				if (pair?.key?.range) [from, to] = pair.key.range;
				key = 'check.unknown';
				params = { field: error.params.additionalProperty };
				break;
			}
			case 'type': {
				const expected = error.params.type.split(',')[0];
				key = (error.data === null || error.data === '') && expected === 'string' ? 'check.empty' : `check.type.${expected}`;
				params.description = ownDescription();
				break;
			}
			case 'minLength':
				key = error.params.limit === 1 ? 'check.empty' : 'check.tooShort';
				params.limit = error.params.limit;
				break;
			case 'maxLength':
				key = 'check.tooLong';
				params.limit = error.params.limit;
				break;
			case 'minItems':
				key = 'check.minItems';
				params.limit = error.params.limit;
				break;
			case 'maxItems':
				key = 'check.maxItems';
				params.limit = error.params.limit;
				break;
			case 'enum':
				key = 'check.enum';
				break;
			case 'const':
				key = 'check.enum';
				params.value = String(error.params.allowedValue);
				break;
			case 'pattern':
			case 'format':
				key = 'check.pattern';
				params.description = ownDescription();
				break;
			case 'minimum':
			case 'exclusiveMinimum':
				key = 'check.minimum';
				params.limit = error.params.limit;
				break;
			case 'maximum':
			case 'exclusiveMaximum':
				key = 'check.maximum';
				params.limit = error.params.limit;
				break;
			default:
				key = 'check.other';
				params.detail = error.message;
		}
		// An empty value has a zero-width range: underline its key instead, or
		// the rest of the line for an empty list item.
		if (to <= from) {
			const parent = segments.length > 1 ? doc.getIn(segments.slice(0, -1), true) : doc.contents;
			const pair = isMap(parent) && parent.items.find((item) => String(item.key?.value) === String(segments.at(-1)));
			if (pair?.key?.range) [from, to] = pair.key.range;
			else to = lineEnd(from);
		}
		const id = `${from}:${to}:${key}:${params.field}`;
		if (seen.has(id)) continue;
		seen.add(id);
		diagnostics.push({ from, to, severity: 'error', key, params });
	}
	return [...syntax, ...diagnostics];
}
