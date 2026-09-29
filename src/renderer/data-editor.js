// YAML/JSON editor for clients: the file is edited as text, with the help a
// non-developer needs to not break it —
//   - indentation handled for them: Enter indents after "key:", aligns under
//     the key after "- key: value", continues a "- text" list, and ends a list
//     on an empty "- "; Tab / Shift+Tab indent by two spaces, never a tab;
//   - mistakes underlined as they type, in plain words (checked in the main
//     process, against the file's JSON Schema when it has one);
//   - with a schema: field names suggested (Ctrl+Space, or as they type) and
//     each field's description on hover.
// Line endings are kept as found, so saving never rewrites the whole file.
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, hoverTooltip, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { json as jsonLanguage } from '@codemirror/lang-json';
import { linter, lintGutter, openLintPanel } from '@codemirror/lint';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { isMap, isPair, isSeq, parseDocument, visit } from 'yaml';
import { propertiesOf, schemaAt, typeOf } from '../shared/schema-path.js';
import { yamlEnter } from './yaml-indent.js';

const dataStyle = HighlightStyle.define([
	{ tag: [tags.propertyName, tags.definition(tags.propertyName)], class: 'dt-key' },
	{ tag: [tags.string, tags.special(tags.string)], class: 'dt-string' },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'dt-literal' },
	{ tag: tags.comment, class: 'dt-comment' },
	{ tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], class: 'dt-punct' },
]);

const PROBE = '__kiri_probe__';

// --- Where things are -------------------------------------------------------

// Schema path of the ancestors `visit` hands over: keys, and '*' for list items.
function pathOf(ancestors) {
	const path = [];
	for (const node of ancestors) {
		if (isPair(node)) path.push(String(node.key?.value));
		else if (isSeq(node)) path.push('*');
	}
	return path;
}

// The key or value under `pos`: { path, from, to }.
function fieldAt(text, pos) {
	let found = null;
	visit(parseDocument(text), {
		Pair(_, pair, ancestors) {
			for (const node of [pair.key, pair.value]) {
				const [from, to] = node?.range ?? [];
				if (from !== undefined && pos >= from && pos <= to && (node === pair.key || !isMap(node) && !isSeq(node))) {
					found = { path: [...pathOf(ancestors), String(pair.key?.value)], from: pair.key.range[0], to };
					return visit.BREAK;
				}
			}
			return undefined;
		},
	});
	return found;
}

// Where a key typed at the start of `lineNumber` would land: replace the line
// with a placeholder key and see where the parser puts it. Returns
// { path, siblings } — the object's path and the keys it already has.
function slotAt(state, lineNumber, prefix) {
	const line = state.doc.line(lineNumber);
	const text = state.doc.sliceString(0, line.from, '\n')
		+ `${prefix}${PROBE}: 0`
		+ state.doc.sliceString(line.to, state.doc.length, '\n');
	let slot = null;
	visit(parseDocument(text), {
		Pair(_, pair, ancestors) {
			if (pair.key?.value !== PROBE) return undefined;
			const map = ancestors.at(-1);
			slot = {
				path: pathOf(ancestors),
				siblings: new Set((isMap(map) ? map.items : []).map((p) => String(p.key?.value)).filter((k) => k !== PROBE)),
			};
			return visit.BREAK;
		},
	});
	return slot;
}

// --- Editor -------------------------------------------------------------------

// createDataEditor(parent, { text, format, schema, check, message, onChange, onProblems, labels })
//   format: 'yaml' | 'json'; schema: JSON Schema or null;
//   check(text) → diagnostics from the main process; message(diagnostic) → text;
//   onProblems(count) after each check. Returns { view, focus, showProblems, destroy }.
export function createDataEditor(parent, { text, format, schema, check, message, onChange, onProblems, labels }) {
	const isYaml = format === 'yaml';

	const lint = linter(async (view) => {
		const doc = view.state.doc;
		const found = await check(doc.sliceString(0, doc.length, '\n'));
		onProblems?.(found.length);
		return found.map((d) => ({
			from: Math.min(d.from, doc.length),
			to: Math.min(Math.max(d.to, d.from), doc.length),
			severity: d.severity,
			message: message(d),
		}));
	}, { delay: 400 });

	const hover = hoverTooltip((view, pos) => {
		if (!schema || !isYaml) return null;
		const field = fieldAt(view.state.doc.sliceString(0, view.state.doc.length, '\n'), pos);
		const sub = field && schemaAt(schema, field.path);
		if (!sub?.description && !sub?.title) return null;
		return {
			pos: field.from,
			end: field.to,
			above: true,
			create() {
				const dom = document.createElement('div');
				dom.className = 'schema-tip';
				const name = document.createElement('strong');
				name.textContent = sub.title || field.path.at(-1);
				dom.append(name);
				if (sub.description) {
					const description = document.createElement('p');
					description.textContent = sub.description;
					dom.append(description);
				}
				return { dom };
			},
		};
	});

	const complete = autocompletion({
		override: [(ctx) => {
			if (!schema || !isYaml) return null;
			const line = ctx.state.doc.lineAt(ctx.pos);
			const typed = /^( *)(- +)?([\w$-]*)$/.exec(line.text.slice(0, ctx.pos - line.from));
			if (!typed || (!typed[3] && !ctx.explicit)) return null;
			const prefix = typed[1] + (typed[2] ?? '');
			const slot = slotAt(ctx.state, line.number, prefix);
			const object = slot && schemaAt(schema, slot.path);
			if (!object) return null;
			const column = prefix.length;
			const options = Object.entries(propertiesOf(schema, object))
				.filter(([name]) => !slot.siblings.has(name))
				.map(([name, { schema: sub, required }]) => {
					const type = typeOf(schema, sub);
					const tail = type === 'array' ? `:\n${' '.repeat(column + 2)}- ` : type === 'object' ? `:\n${' '.repeat(column + 2)}` : ': ';
					return {
						label: name,
						detail: required ? labels.required : undefined,
						info: sub.description || undefined,
						boost: required ? 1 : 0,
						apply: name + tail,
					};
				});
			return options.length ? { from: line.from + column, options, validFor: /^[\w$-]*$/ } : null;
		}],
	});

	const eol = /\r\n/.test(text) ? '\r\n' : '\n';
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: text,
			extensions: [
				EditorState.lineSeparator.of(eol),
				EditorState.tabSize.of(2),
				indentUnit.of('  '),
				history(),
				drawSelection(),
				Prec.highest(keymap.of([
					...(isYaml ? [{ key: 'Enter', run: yamlEnter }] : []),
					{ key: 'Tab', run: indentMore },
					{ key: 'Shift-Tab', run: indentLess },
				])),
				keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
				isYaml ? yamlLanguage() : jsonLanguage(),
				syntaxHighlighting(dataStyle),
				EditorView.lineWrapping,
				lint,
				lintGutter(),
				hover,
				complete,
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onChange(update.state.doc.toString());
				}),
			],
		}),
	});
	return {
		view,
		focus: () => view.focus(),
		// The list of problems under the editor; each one jumps to its line.
		showProblems: () => openLintPanel(view),
		destroy: () => view.destroy(),
	};
}
