import fs from 'node:fs';
import path from 'node:path';
import ts from '../../signals-royale-sx1/node_modules/typescript/lib/typescript.js';

const roots = [
	'packages/signals-royale-sx1/src',
	'packages/react-signals-royale-sx1/src',
];
let total = 0;

for (const root of roots) {
	for (const name of fs.readdirSync(root)) {
		if (!/\.tsx?$/.test(name)) continue;
		const file = path.join(root, name);
		const source = fs.readFileSync(file, 'utf8');
		const starts = ts.computeLineStarts(source);
		const lines = new Set();
		const scanner = ts.createScanner(
			ts.ScriptTarget.Latest,
			true,
			ts.LanguageVariant.Standard,
			source,
		);
		for (
			let token = scanner.scan();
			token !== ts.SyntaxKind.EndOfFileToken;
			token = scanner.scan()
		) {
			const first = ts.computeLineAndCharacterOfPosition(starts, scanner.getTokenPos()).line;
			const last = ts.computeLineAndCharacterOfPosition(starts, scanner.getTextPos()).line;
			for (let line = first; line <= last; line++) lines.add(line);
		}
		console.log(`${file}: ${lines.size}`);
		total += lines.size;
	}
}

console.log(`total: ${total}`);
