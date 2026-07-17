/**
 * Tiny syntax highlighter for the inspector's value and source previews. Not a
 * real parser — one alternation over the token kinds that actually show up in
 * our previews (JSON-ish values and stringified JS functions): comments,
 * strings, keywords, literals, object keys, numbers. Everything else renders
 * plain. Colors come from the active base16 theme vars.
 */
import type { ReactNode } from "react"

// Order matters: comment, string, keyword, literal, object-key (ident before a
// colon), number. A key is captured without its colon (lookahead), so the
// match text is just the identifier.
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(const|let|var|function|return|if|else|for|while|new|typeof|instanceof|of|in|this|void|await|async|class|extends|yield)\b|\b(true|false|null|undefined|NaN|Infinity)\b|([A-Za-z_$][\w$]*)(?=\s*:)|(-?\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b)/g

function classOf(m: RegExpMatchArray): string {
  return m[1]
    ? "tok-com"
    : m[2]
      ? "tok-str"
      : m[3]
        ? "tok-kw"
        : m[4]
          ? "tok-lit"
          : m[5]
            ? "tok-key"
            : "tok-num"
}

export function Code({ children }: { children: string }) {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of children.matchAll(TOKEN)) {
    const i = m.index ?? 0
    if (i > last) out.push(children.slice(last, i))
    out.push(
      <span key={key++} className={classOf(m)}>
        {m[0]}
      </span>,
    )
    last = i + m[0].length
  }
  if (last < children.length) out.push(children.slice(last))
  return <>{out}</>
}
