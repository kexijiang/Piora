# Sourced after the user's zshrc, only inside a Piora terminal.
typeset -g __piora_token="$PIORA_SHELL_TOKEN"
unset PIORA_SHELL_TOKEN
typeset -g __piora_command_names=''
__piora_b64() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
__piora_emit() {
  printf '\033]633;Piora;%s;%s;%s;%s;%s;%s\007' "$__piora_token" "$1" "$(__piora_b64 "$PWD")" "$2" "$3" "$(__piora_b64 "$4")"
}
__piora_dispatch() {
  local __piora_code
  __piora_code=$(printf '%s' "$1" | base64 -d)
  __piora_emit start '' "$2" "$__piora_code"
  eval "$__piora_code"
}
__piora_preexec() {
  [[ "$1" == __piora_dispatch* ]] || __piora_emit start '' '' "$1"
}
__piora_precmd() {
  local __piora_exit=$?
  local __piora_names
  __piora_names=$(print -l -- ${(k)aliases} ${(k)functions})
  if (( ${#__piora_names} > 16000 )); then
    __piora_names=${__piora_names[1,16000]}
    __piora_names=${__piora_names%$'\n'*}
  fi
  if [[ "$__piora_names" != "$__piora_command_names" ]]; then
    __piora_emit catalog '' '' "$__piora_names"
    __piora_command_names=$__piora_names
  fi
  __piora_emit prompt "$__piora_exit" '' ''
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __piora_preexec
add-zsh-hook precmd __piora_precmd
__piora_emit ready 1 '' ''
