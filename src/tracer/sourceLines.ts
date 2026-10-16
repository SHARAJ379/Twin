/**
 * Splits file content into lines on any of the three line endings, so a rule
 * never sees a stray `\r`.
 *
 * Splitting on "\n" alone leaves CRLF files with a carriage return at the end
 * of every line, and that silently breaks the static rules: a JavaScript `.`
 * matches anything *except* a line terminator, so `(\/\/.*)?$` in a pattern
 * like moduleStateRule's can't cross the `\r` to reach end-of-input. The
 * effect is narrow enough to hide for a long time - `const items = [];`
 * still matches, because `\s*` happily eats the `\r`, while
 * `const items = []; // { id, name }` does not - so the lines that lost their
 * suspect were exactly the ones carrying an explanatory comment.
 *
 * Git checks out LF files as CRLF on Windows by default (`core.autocrlf`), so
 * this is the normal state of a Windows checkout, not an edge case.
 */
export function splitLines(content: string): string[] {
  return content.split(/\r\n|[\n\r]/);
}
