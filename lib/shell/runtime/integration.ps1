# Loaded only in a Piora-owned PowerShell process. Preserve the user's profile.
$global:__PioraToken = $env:PIORA_SHELL_TOKEN
Remove-Item Env:PIORA_SHELL_TOKEN -ErrorAction SilentlyContinue
$global:__PioraPending = $false
$global:__PioraDispatching = $false
$global:__PioraOldPrompt = $function:prompt
$global:__PioraExitCode = $null
$global:__PioraCommandNames = ''

function global:__PioraEmit([string]$Kind, [string]$Status = '', [string]$Id = '', [string]$Command = '') {
    $pioraCwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ExecutionContext.SessionState.Path.CurrentFileSystemLocation.Path))
    $pioraCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
    [Console]::Write(([char]27).ToString() + ']633;Piora;' + $global:__PioraToken + ';' + $Kind + ';' + $pioraCwd + ';' + $Status + ';' + $Id + ';' + $pioraCommand + [char]7)
}
function global:__PioraDispatch([string]$PioraPayload, [string]$PioraId) {
    $global:__PioraDispatching = $true
    $global:__PioraPending = $true
    $global:LASTEXITCODE = 0
    $global:__PioraExitCode = $null
    __PioraEmit 'start' '' $PioraId ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PioraPayload)))
    # Called with dot sourcing, so variables, functions and cwd survive the command.
    . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PioraPayload)) + "`n__PioraSaveStatus `$? `$global:LASTEXITCODE"))
}
function global:__PioraSaveStatus([bool]$Success, $Code) {
    if ($null -eq $Code) { $Code = 0 }
    if (-not $Success -and $Code -eq 0) { $Code = 1 }
    $global:__PioraExitCode = $Code
}
function global:__PioraPublishCommands {
    $pioraNames = ((Get-Command -CommandType Alias,Function -ErrorAction SilentlyContinue).Name | Sort-Object -Unique) -join "`n"
    if ($pioraNames.Length -gt 16000) { $pioraNames = $pioraNames.Substring(0, 16000); $pioraNames = $pioraNames.Substring(0, [Math]::Max(0, $pioraNames.LastIndexOf("`n"))) }
    if ($pioraNames -ne $global:__PioraCommandNames) { __PioraEmit 'catalog' '' '' $pioraNames; $global:__PioraCommandNames = $pioraNames }
}
function global:prompt {
    $pioraSuccess = $?
    $pioraExit = $global:LASTEXITCODE
    if ($null -eq $pioraExit) { $pioraExit = 0 }
    if (-not $pioraSuccess -and $pioraExit -eq 0) { $pioraExit = 1 }
    if ($null -ne $global:__PioraExitCode) { $pioraExit = $global:__PioraExitCode }
    __PioraPublishCommands
    __PioraEmit 'prompt' ([string]$pioraExit)
    $global:__PioraPending = $false
    $global:__PioraDispatching = $false
    $global:__PioraExitCode = $null
    if ($global:__PioraOldPrompt) { & $global:__PioraOldPrompt } else { 'PS ' + $PWD + '> ' }
}
$pioraRawCapture = '0'
try {
    Import-Module PSReadLine -ErrorAction Stop
    $global:__PioraPreviousHistoryHandler = (Get-PSReadLineOption).AddToHistoryHandler
    Set-PSReadLineOption -AddToHistoryHandler {
        param([string]$line)
        if ($line.StartsWith('. __PioraDispatch ')) { return $false }
        if ($global:__PioraPreviousHistoryHandler) { return $global:__PioraPreviousHistoryHandler.Invoke($line) }
        return $true
    }
    # History handlers can skip repeated or excluded commands. Observe the
    # accepted input instead, while preserving the user's line editor itself.
    $global:__PioraReadLine = $function:PSConsoleHostReadLine
    if ($global:__PioraReadLine) {
        function global:PSConsoleHostReadLine {
            $pioraLine = [string]$global:__PioraReadLine.Invoke()
            if ($pioraLine.Trim() -and -not $pioraLine.StartsWith('. __PioraDispatch ')) {
                $global:LASTEXITCODE = 0
                $global:__PioraPending = $true
                __PioraEmit 'start' '' '' $pioraLine
            }
            return $pioraLine
        }
        $pioraRawCapture = '1'
    }
} catch {
    # Structured submissions still work; unmanaged input is not guessed.
}
__PioraEmit 'ready' $pioraRawCapture
