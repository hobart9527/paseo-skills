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
