# Sourced after the user's bashrc, only inside a Piora terminal.
__piora_token="$PIORA_SHELL_TOKEN"
unset PIORA_SHELL_TOKEN
__piora_at_prompt=0
__piora_dispatching=0
__piora_command_names=''
__piora_b64() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
__piora_emit() {
  local __piora_cwd="$PWD"
  # MSYS /tmp and /d paths are shell mount points, not native Node/Windows
  # paths. Report the real filesystem cwd for completion and child terminals.
  if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then
    __piora_cwd=$(cygpath -w "$PWD")
  fi
  printf '\033]633;Piora;%s;%s;%s;%s;%s;%s\007' "$__piora_token" "$1" "$(__piora_b64 "$__piora_cwd")" "$2" "$3" "$(__piora_b64 "$4")"
}
__piora_dispatch() {
  __piora_at_prompt=0
  __piora_dispatching=1
  local __piora_code
  __piora_code=$(printf '%s' "$1" | base64 -d)
  __piora_emit start '' "$2" "$__piora_code"
  eval "$__piora_code"
}
__piora_debug() {
  if [[ "$__piora_at_prompt" == 1 && "$BASH_COMMAND" != __piora_prompt* ]]; then
    __piora_at_prompt=0
    if [[ "$BASH_COMMAND" != __piora_dispatch* ]]; then
      local __piora_line
      __piora_line=$(HISTTIMEFORMAT= builtin history 1)
      __piora_line=${__piora_line#*[0-9]  }
      __piora_emit start '' '' "$__piora_line"
    fi
  fi
}
__piora_prompt() {
  local __piora_exit=$?
  local __piora_names
  __piora_names=$(compgen -a; compgen -A function)
  if (( ${#__piora_names} > 16000 )); then
    __piora_names=${__piora_names:0:16000}
    __piora_names=${__piora_names%$'\n'*}
  fi
  if [[ "$__piora_names" != "$__piora_command_names" ]]; then
    __piora_emit catalog '' '' "$__piora_names"
    __piora_command_names=$__piora_names
  fi
  __piora_emit prompt "$__piora_exit" '' ''
  __piora_dispatching=0
  __piora_at_prompt=1
}
# A pre-existing DEBUG trap owns this shell hook; preserve it and report raw
# capture unavailable rather than breaking the user's shell customization.
if [[ -z "$(trap -p DEBUG)" ]]; then
  trap '__piora_debug' DEBUG
  __piora_raw=1
else
  __piora_raw=0
fi
PROMPT_COMMAND=(__piora_prompt "${PROMPT_COMMAND[@]}")
__piora_emit ready "$__piora_raw" '' ''
