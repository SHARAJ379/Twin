/**
 * One argument, quoted for the shell Twin hands commands to - `shell: true`
 * means cmd.exe on Windows and sh everywhere else - so a path with spaces in
 * it (C:\Users\Jane Doe\...) stays one argument.
 */
export function quoteForShell(text: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    // cmd.exe has no way to escape a double quote inside double quotes, and
    // no Windows path can contain one.
    if (text.includes('"')) throw new Error(`can't quote ${text} for cmd.exe: it contains a double quote`);
    return `"${text}"`;
  }
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
