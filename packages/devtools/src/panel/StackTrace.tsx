import { useState } from 'react'
import type { StackFrame } from '../protocol.ts'

/**
 * Renders the app stack captured at an operation root, with each frame linked
 * to open in an editor. The runtime reports source locations as URLs (e.g. a
 * dev-server URL); editors want a filesystem path, so a small settings row
 * lets you pick the editor and a project-root prefix, remembered in
 * localStorage. Choose "no links" to just read the frames.
 */
// `path` is absolute (starts with "/"), so it follows `file` directly — the
// editor scheme is `cursor://file` + "/abs/path", e.g.
// `cursor://file/Users/me/app/src/App.tsx:12:3`. An extra slash
// (`file//Users…`) makes the editor read the whole tail as a filename and drop
// the line/column.
const EDITORS: Record<string, (path: string, line: number, col: number) => string> = {
	cursor: (p, l, c) => `cursor://file${p}:${l}:${c}`,
	vscode: (p, l, c) => `vscode://file${p}:${l}:${c}`,
	webstorm: (p, l) => `webstorm://open?file=${encodeURIComponent(p)}&line=${l}`,
	none: () => '',
}

function get(key: string, fallback: string): string {
	try {
		return localStorage.getItem(key) ?? fallback
	} catch {
		return fallback
	}
}
function set(key: string, value: string): void {
	try {
		localStorage.setItem(key, value)
	} catch {
		/* private mode — settings just won't persist */
	}
}

/** The dev server's filesystem root, if the `signals-devtools/vite` plugin
 * published it — used as the default project root so links open real files
 * with no setup. A path typed into the panel is stored separately and wins. */
function injectedProjectRoot(): string {
	const r = (globalThis as { __SIGNALS_DEVTOOLS_PROJECT_ROOT__?: string }).__SIGNALS_DEVTOOLS_PROJECT_ROOT__
	return typeof r === 'string' ? r : ''
}

/** The runtime file is usually a URL; reduce it to a path and prefix the
 * configured project root so an editor can resolve it. */
function toPath(file: string, root: string): string {
	let path = file
	try {
		path = new URL(file).pathname
	} catch {
		/* already a path */
	}
	return root ? root.replace(/\/$/, '') + path : path
}

function basename(file: string): string {
	try {
		return new URL(file).pathname.split('/').pop() || file
	} catch {
		return file.split('/').pop() || file
	}
}

export function StackTrace({ frames }: { frames: StackFrame[] }) {
	const [editor, setEditor] = useState(() => get('signals-devtools-editor', 'cursor'))
	const [root, setRoot] = useState(() => get('signals-devtools-root', injectedProjectRoot()))
	const link = EDITORS[editor] ?? EDITORS.cursor
	return (
		<div className="cz-section">
			<h3 data-tip="The app stack captured when this operation began — the code that triggered it.">Stack</h3>
			<ul className="stack">
				{frames.map((f, i) => {
					const href = editor === 'none' ? '' : link(toPath(f.file, root), f.line, f.col)
					const label = `${basename(f.file)}:${f.line}`
					return (
						// eslint-disable-next-line react/no-array-index-key -- frames are positional
						<li key={i}>
							<span className="fn">{f.fn}</span>
							{href ? (
								<a className="srclink" href={href}>
									{label}
								</a>
							) : (
								<span className="loc">{label}</span>
							)}
						</li>
					)
				})}
			</ul>
			<div className="stack-editor">
				open in
				<select
					value={editor}
					onChange={(e) => {
						setEditor(e.target.value)
						set('signals-devtools-editor', e.target.value)
					}}
				>
					<option value="cursor">Cursor</option>
					<option value="vscode">VS Code</option>
					<option value="webstorm">WebStorm</option>
					<option value="none">no links</option>
				</select>
				<input
					className="stack-root"
					placeholder="project root (abs path)"
					value={root}
					spellCheck={false}
					onChange={(e) => {
						setRoot(e.target.value)
						set('signals-devtools-root', e.target.value)
					}}
				/>
			</div>
		</div>
	)
}
