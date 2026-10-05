/**
 * Shell completion scripts, generated from the command registry so they never
 * drift from the real flags.
 */
export interface CompletionSpec {
  name: string;
  summary: string;
  flags: { name: string; short?: string; value?: string; choices?: string[]; complete?: 'files' | 'refs' | 'none'; description: string }[];
  /** What the positional arguments complete to. */
  positional?: 'dirs' | 'files' | string[];
}

export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

const flagWords = (c: CompletionSpec) => c.flags.flatMap((f) => [`--${f.name}`, ...(f.short ? [`-${f.short}`] : [])]);

function bash(cmds: CompletionSpec[]): string {
  const cases = cmds
    .map((c) => {
      const valued = c.flags.filter((f) => f.value);
      const prevCases = valued
        .map((f) => {
          const words = f.choices ? `"${f.choices.join(' ')}"` : f.complete === 'refs' ? '"$(git for-each-ref --format=\'%(refname:short)\' 2>/dev/null) HEAD"' : '';
          const action = words ? `COMPREPLY=($(compgen -W ${words} -- "$cur"))` : f.complete === 'none' ? 'COMPREPLY=()' : 'COMPREPLY=($(compgen -f -- "$cur"))';
          return `        --${f.name}${f.short ? `|-${f.short}` : ''}) ${action}; return ;;`;
        })
        .join('\n');
      const pos = Array.isArray(c.positional) ? `compgen -W "${c.positional.join(' ')}" -- "$cur"` : c.positional === 'files' ? 'compgen -f -- "$cur"' : 'compgen -d -- "$cur"';
      return `    ${c.name})
      case "$prev" in
${prevCases}
      esac
      if [[ "$cur" == -* ]]; then COMPREPLY=($(compgen -W "${flagWords(c).join(' ')}" -- "$cur")); else COMPREPLY=($(${pos})); fi
      ;;`;
    })
    .join('\n');
  return `# oodle bash completion. Install: oodle completion bash >> ~/.bashrc
_oodle() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${cmds.map((c) => c.name).join(' ')} --help --version" -- "$cur"))
    return
  fi
  case "$cmd" in
${cases}
  esac
}
complete -o filenames -F _oodle oodle
`;
}

function zsh(cmds: CompletionSpec[]): string {
  const q = (s: string) => s.replace(/'/g, "'\\''").replace(/[[\]:]/g, '\\$&');
  const sub = cmds
    .map((c) => {
      const flags = c.flags.map((f) => {
        const what = f.choices ? `(${f.choices.join(' ')})` : f.complete === 'refs' ? '__git_refs' : f.complete === 'none' ? ' ' : '_files';
        const action = f.value ? `:${f.value}:${what}` : '';
        const names = f.short ? `'(-${f.short} --${f.name})'{-${f.short},--${f.name}}'` : `'--${f.name}`;
        return `      ${names}[${q(f.description)}]${action}'`;
      });
      const pos = Array.isArray(c.positional) ? `'1:arg:(${c.positional.join(' ')})'` : c.positional === 'files' ? "'*:file:_files'" : "'*:project:_directories'";
      return `    (${c.name})\n      _arguments -s \\\n${[...flags, `      ${pos}`].join(' \\\n')}\n      ;;`;
    })
    .join('\n');
  return `#compdef oodle
# oodle zsh completion. Install: oodle completion zsh > "\${fpath[1]}/_oodle"
_oodle() {
  local -a commands
  commands=(
${cmds.map((c) => `    '${c.name}:${q(c.summary)}'`).join('\n')}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'oodle command' commands
    return
  fi
  __git_refs() { local -a refs; refs=(\${(f)"$(git for-each-ref --format='%(refname:short)' 2>/dev/null)"} HEAD); _describe -t refs 'git ref' refs; }
  local cmd=\${words[2]}
  shift words; (( CURRENT-- ))
  case $cmd in
${sub}
  esac
}
compdef _oodle oodle
`;
}

function fish(cmds: CompletionSpec[]): string {
  const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
  const lines = [
    '# oodle fish completion. Install: oodle completion fish > ~/.config/fish/completions/oodle.fish',
    'complete -c oodle -f',
    ...cmds.map((c) => `complete -c oodle -n __fish_use_subcommand -a ${c.name} -d ${q(c.summary)}`),
  ];
  for (const c of cmds) {
    for (const f of c.flags) {
      const parts = [`complete -c oodle -n '__fish_seen_subcommand_from ${c.name}' -l ${f.name}`];
      if (f.short) parts.push(`-s ${f.short}`);
      if (f.value) parts.push(f.choices ? `-xa ${q(f.choices.join(' '))}` : f.complete === 'refs' ? "-xa '(__fish_git_refs 2>/dev/null; echo HEAD)'" : f.complete === 'none' ? '-x' : '-r -F');
      parts.push(`-d ${q(f.description)}`);
      lines.push(parts.join(' '));
    }
    if (Array.isArray(c.positional)) lines.push(`complete -c oodle -n '__fish_seen_subcommand_from ${c.name}' -xa ${q(c.positional.join(' '))}`);
    else lines.push(`complete -c oodle -n '__fish_seen_subcommand_from ${c.name}' -xa '(__fish_complete_directories)'`);
  }
  return `${lines.join('\n')}\n`;
}

export function completion(shell: Shell, cmds: CompletionSpec[]): string {
  return { bash, zsh, fish }[shell](cmds);
}
