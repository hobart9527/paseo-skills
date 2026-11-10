// Shared argument parsing for the pipeline CLIs. The `--flag value` skip appears in several
// scripts; getting it wrong makes the value look positional, so it lives in one place. Value
// validation and exit codes stay with each script.

/** Raw value after `--name`, or `null` when the flag is absent. */
export function argValue(args, name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? null : args[index + 1];
}

/** Positional arguments with every `--flag value` pair removed. */
export function positionalArgs(args, valueFlags = []) {
  const skip = new Set(valueFlags.map((name) => (name.startsWith('--') ? name : `--${name}`)));
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (skip.has(args[index])) { index += 1; continue; }
    if (!args[index].startsWith('--')) positional.push(args[index]);
  }
  return positional;
}

/** Strict long-option parser; schema values are 'value', 'repeat', or 'boolean'. */
export function parseOptions(args, schema) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    const name = match?.[1];
    const type = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!match || !type) throw new Error(`unknown option: ${arg}`);
    if (type === 'boolean') {
      if (match[2] !== undefined) throw new Error(`--${name} takes no value`);
      options[name] = true;
      continue;
    }
    const value = match[2] === undefined ? args[++i] : match[2];
    if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    if (type === 'repeat') (options[name] ??= []).push(value);
    else {
      if (options[name] !== undefined) throw new Error(`duplicate option: --${name}`);
      options[name] = value;
    }
  }
  return { positional, options };
}

export const planOptions = { json: 'boolean', 'worker-cap': 'value', 'idle-minutes': 'value', 'other-change': 'repeat', 'allow-attempt-over': 'repeat' };
