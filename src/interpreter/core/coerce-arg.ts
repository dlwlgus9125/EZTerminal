/**
 * Argument coercion — the one place a parsed argument {@link Expression} becomes
 * a raw string argument (architecture §6/§7).
 *
 * Both edges cross this single seam: builtin bare-word args (`run-script`,
 * `ssh-connect`) and external command argv (`commandToArgv`). Bare words are
 * literal text (not column references), so this does NOT go through
 * `evalExpression` (which rejects identifiers outside row scope). `$name` /
 * `$env.NAME` resolve against the live {@link EvalContext}; every scalar
 * RuntimeValue kind stringifies (datetime → ISO). `label` prefixes error
 * messages with the calling command's name.
 *
 * `cd` deliberately keeps its own stricter path coercion (`cdPathArg` in
 * builtins): a path must be a string and an omitted path means home — neither
 * applies to a general argument, so it is not routed through here.
 */

import type { Expression } from './ast';
import { EvalError } from './errors';
import type { EvalContext } from './types';

export function coerceArg(expr: Expression, ctx: EvalContext, label: string): string {
  switch (expr.type) {
    case 'identifier':
      return expr.name;
    case 'string':
      return expr.value;
    case 'number':
      return String(expr.value);
    case 'bool':
      return String(expr.value);
    case 'filesize':
      return String(expr.bytes);
    case 'null':
      return 'null';
    case 'variable': {
      const value = ctx.session.getVar(expr.name);
      if (value === undefined) throw new EvalError(`undefined variable: $${expr.name}`, expr.span);
      switch (value.kind) {
        case 'null':
          return 'null';
        case 'bool':
          return String(value.value);
        case 'number':
          return String(value.value);
        case 'string':
          return value.value;
        case 'filesize':
          return String(value.bytes);
        case 'datetime':
          return new Date(value.epochMs).toISOString();
        default:
          throw new EvalError(`${label}: $${expr.name} is a ${value.kind}, not a valid argument`, expr.span);
      }
    }
    case 'env': {
      const raw = ctx.env[expr.name];
      if (raw === undefined) throw new EvalError(`${label}: $env.${expr.name} is not set`, expr.span);
      return raw;
    }
    case 'binary':
      throw new EvalError(`${label}: comparison expressions are not valid arguments`, expr.span);
  }
}
