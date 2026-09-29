// Enter in YAML, so clients never count spaces: indents after "key:",
// aligns under the key after "- key: value", continues a "- text" list, and
// ends a list when Enter is pressed on an empty "- ". Two spaces per level.
// Works on anything shaped like an EditorView ({ state, dispatch }).

const leading = (text) => /^ */.exec(text)[0].length;
const isKeyValue = (text) => /^[^\s#'"[{-][^#]*?:(\s|$)/.test(text) || /^["'][^"']*["']\s*:(\s|$)/.test(text);

export function yamlEnter(view) {
	const { state } = view;
	const range = state.selection.main;
	if (!range.empty) return false;
	const line = state.doc.lineAt(range.head);
	const before = line.text.slice(0, range.head - line.from);
	const indent = leading(line.text);
	const item = /^( *)- ?(.*)$/.exec(before);

	// Enter on an empty "- ": end the list, one level out.
	if (item && item[2].trim() === '' && line.text.slice(before.length).trim() === '') {
		const outdent = Math.max(0, indent - 2);
		view.dispatch({
			changes: { from: line.from, to: line.to, insert: ' '.repeat(outdent) },
			selection: { anchor: line.from + outdent },
			userEvent: 'input',
		});
		return true;
	}

	let insert;
	const content = item ? item[2] : before.trim();
	const column = item ? indent + 2 : indent; // where this line's key starts
	if (/:\s*$/.test(content) && !content.startsWith('#')) insert = ' '.repeat(column + 2); // "key:" opens a block
	else if (item && !isKeyValue(content)) insert = `${' '.repeat(indent)}- `; // next item of a plain list
	else insert = ' '.repeat(column); // next key at the same level
	view.dispatch({ ...state.replaceSelection(`\n${insert}`), scrollIntoView: true, userEvent: 'input' });
	return true;
}
