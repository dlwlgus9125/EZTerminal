/**
 * Encode one literal value for insertion into EZTerminal's command language.
 *
 * The EZ lexer treats backslash as an escape prefix inside either quote style,
 * so Windows paths must double every backslash. Single quotes keep ordinary
 * double quotes readable and only require escaping `\\` and `'` (plus the two
 * control characters for which the lexer has named escapes).
 */
export function quoteEzArgument(value: string): string {
  let encoded = "'";
  for (const character of value) {
    switch (character) {
      case '\\':
        encoded += '\\\\';
        break;
      case "'":
        encoded += "\\'";
        break;
      case '\n':
        encoded += '\\n';
        break;
      case '\t':
        encoded += '\\t';
        break;
      default:
        encoded += character;
    }
  }
  return `${encoded}'`;
}

