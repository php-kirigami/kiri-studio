// Markdown editor for clients: CodeMirror 6 with Markdown styled in place
// (headings bigger, bold bold, links colored) and a toolbar, so formatting
// never requires knowing the syntax. The Markdown source itself is what gets
// saved, untouched outside the client's edits: no reformatting, clean diffs.
import { EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

// Classes only; the look lives in styles.css.
const markdownStyle = HighlightStyle.define([
	{ tag: tags.heading1, class: 'md-h1' },
	{ tag: tags.heading2, class: 'md-h2' },
	{ tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: 'md-h3' },
	{ tag: tags.strong, class: 'md-strong' },
	{ tag: tags.emphasis, class: 'md-em' },
	{ tag: tags.link, class: 'md-link' },
	{ tag: tags.url, class: 'md-url' },
	{ tag: tags.monospace, class: 'md-code' },
	{ tag: tags.quote, class: 'md-quote' },
	// Syntax marks (#, **, list bullets and numbers, >) stay visible but quiet.
	{ tag: [tags.processingInstruction, tags.contentSeparator], class: 'md-mark' },
]);

// Fenced code blocks: one full-width background per line (fence lines included),
// instead of a patchy background behind each text run.
const fenceLine = Decoration.line({ class: 'md-fence-line' });
const fenceLines = ViewPlugin.fromClass(class {
	constructor(view) { this.decorations = this.build(view); }
	update(update) {
		if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
			this.decorations = this.build(update.view);
		}
	}
	build(view) {
		const builder = new RangeSetBuilder();
		let last = -1;
		for (const { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from, to,
				enter: (node) => {
					if (node.name !== 'FencedCode') return;
					const end = view.state.doc.lineAt(node.to).number;
					for (let n = view.state.doc.lineAt(node.from).number; n <= end; n++) {
						const line = view.state.doc.line(n);
						if (line.from <= last) continue;
						builder.add(line.from, line.from, fenceLine);
						last = line.from;
					}
				},
			});
		}
		return builder.finish();
	}
}, { decorations: (plugin) => plugin.decorations });

// Wraps each selection in `before`/`after`, or unwraps it when already wrapped.
function wrap(view, before, after = before) {
	view.dispatch(view.state.changeByRange((range) => {
		const doc = view.state.doc;
		const outside = doc.sliceString(range.from - before.length, range.from) === before
			&& doc.sliceString(range.to, range.to + after.length) === after;
		if (outside) {
			return {
				changes: [
					{ from: range.from - before.length, to: range.from },
					{ from: range.to, to: range.to + after.length },
				],
				range: EditorSelection.range(range.from - before.length, range.to - before.length),
			};
		}
		return {
			changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
			range: EditorSelection.range(range.from + before.length, range.to + before.length),
		};
	}));
	view.focus();
}

// Toggles a line prefix ("## ", "- ", "> "…) on every selected line. `strip`
// matches any prefix of the same family, so a heading level can be switched.
function prefixLines(view, prefix, strip) {
	const { state } = view;
	const lines = new Map();
	for (const range of state.selection.ranges) {
		for (let pos = range.from; pos <= range.to;) {
			const line = state.doc.lineAt(pos);
			lines.set(line.number, line);
			pos = line.to + 1;
		}
	}
	const all = [...lines.values()];
	const remove = all.every((line) => line.text.startsWith(prefix));
	const changes = all.map((line) => {
		const existing = strip.exec(line.text)?.[0] ?? '';
		return { from: line.from, to: line.from + existing.length, insert: remove ? '' : prefix };
	});
	view.dispatch({ changes });
	view.focus();
}

function link(view) {
	const range = view.state.selection.main;
	const text = view.state.sliceDoc(range.from, range.to) || 'link';
	const url = 'https://';
	const insert = `[${text}](${url})`;
	const urlStart = range.from + text.length + 3;
	view.dispatch({
		changes: { from: range.from, to: range.to, insert },
		selection: EditorSelection.range(urlStart, urlStart + url.length),
	});
	view.focus();
}

// Inserts `text` as a paragraph of its own at the cursor (an image code, …).
export function insertBlock(view, text) {
	const { state } = view;
	const at = state.selection.main.to;
	const line = state.doc.lineAt(at);
	const before = line.text.slice(0, at - line.from).trim() ? '\n\n' : '';
	const after = line.text.slice(at - line.from).trim() ? '\n\n' : '\n';
	const insert = `${before}${text}${after}`;
	view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true });
	view.focus();
}

const HEADING = /^#{1,6} /;
export const actions = {
	bold: (view) => wrap(view, '**'),
	italic: (view) => wrap(view, '_'),
	heading: (view) => prefixLines(view, '## ', HEADING),
	subheading: (view) => prefixLines(view, '### ', HEADING),
	bullets: (view) => prefixLines(view, '- ', /^([-*+]|\d+\.) /),
	numbers: (view) => prefixLines(view, '1. ', /^([-*+]|\d+\.) /),
	quote: (view) => prefixLines(view, '> ', /^> /),
	link,
};

// createMarkdownEditor(parent, { text, onChange }) → { view, focus, destroy }.
export function createMarkdownEditor(parent, { text, onChange }) {
	const shortcuts = keymap.of([
		{ key: 'Mod-b', run: (view) => (actions.bold(view), true) },
		{ key: 'Mod-i', run: (view) => (actions.italic(view), true) },
		{ key: 'Mod-k', run: (view) => (actions.link(view), true) },
	]);
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: text,
			extensions: [
				// Keep the file's line endings, so saving never rewrites every line.
				EditorState.lineSeparator.of(/\r\n/.test(text) ? '\r\n' : '\n'),
				history(),
				drawSelection(),
				shortcuts,
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown(),
				syntaxHighlighting(markdownStyle),
				fenceLines,
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on' }),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onChange(update.state.doc.toString());
				}),
			],
		}),
	});
	return { view, focus: () => view.focus(), destroy: () => view.destroy() };
}
