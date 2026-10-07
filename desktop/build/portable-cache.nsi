!include "common.nsh"

# PIORA_PORTABLE_CACHE_TEMPLATE_V2
# Direct long-path-aware extraction avoids Nsis7z/CopyFiles truncation and
# blocking retry dialogs. Only the reviewed x64 embedded archive is supported.
!ifndef APP_64
  !error "Piora portable requires the reviewed x64 embedded archive"
!endif
!ifdef APP_32
  !error "Piora portable does not support an x86 payload"
!endif
!ifdef APP_ARM64
  !error "Piora portable does not support an ARM64 payload"
!endif
# Do not reread the multi-gigabyte wrapper on every cached launch. Cold
# extraction checks archive CRC and then the independent full SHA-256 manifest.
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}
# File extraction errors set the error flag instead of asking retry/ignore.
SetOverwrite try
Var PortableMutex
Var PortableStatus
Var PortableOutput
Var PortableStage
Var PortableError
Var PortableNodeMode
Var PortableNodeOptions

Function .onInit
  !ifndef SPLASH_IMAGE
    SetSilent silent
  !endif
  ${if} ${RunningX64}
    SetRegView 64
  ${else}
    SetErrorLevel 2
    Quit
  ${endIf}
FunctionEnd

Function .onGUIInit
  InitPluginsDir
  !ifdef SPLASH_IMAGE
    ClearErrors
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    IfErrors splash_unavailable
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
    splash_unavailable:
  !endif
FunctionEnd

Section
  InitPluginsDir
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif
  StrCpy $INSTDIR "$LOCALAPPDATA\Piora\portable\${UNPACK_DIR_NAME}"
  StrCpy $PortableMutex 0
  StrCpy $PortableError "Portable preparation failed"
  System::Call 'kernel32::CreateMutexW(p0, i1, w"Local\PioraPortable-${UNPACK_DIR_NAME}") p.r0 ?e'
  Pop $PortableStatus
  StrCpy $PortableMutex $0
  ${if} $PortableMutex == 0
    StrCpy $PortableError "Unable to create portable cache mutex"
    Goto failed
  ${endIf}
  ${if} $PortableStatus == 183
    System::Call 'kernel32::WaitForSingleObject(p $PortableMutex, i 900000) i.r0'
    # WAIT_OBJECT_0 and WAIT_ABANDONED grant ownership; all other results fail.
    ${if} $0 != 0
    ${andIf} $0 != 128
      StrCpy $PortableError "Portable cache mutex wait failed: $0"
      System::Call 'kernel32::CloseHandle(p $PortableMutex)'
      StrCpy $PortableMutex 0
      Goto failed
    ${endIf}
  ${endIf}

  # Warm launches only read the small marker; no full-tree hash on this path.
  IfFileExists "$INSTDIR\.piora-runtime-ready" 0 prepare_runtime
  ClearErrors
  FileOpen $0 "$INSTDIR\.piora-runtime-ready" r
  IfErrors prepare_runtime
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "${VERSION}" 0 prepare_runtime
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" runtime_ready prepare_runtime

  prepare_runtime:
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $PortableStage "$INSTDIR.pending-$0"
    ClearErrors
    SetOutPath $PLUGINSDIR
    SetCompress off
    File /oname=$PLUGINSDIR\payload.7z "${APP_64}"
    File /oname=$PLUGINSDIR\7za.exe "${PROJECT_DIR}\build\portable-extractor\7za.exe"
    File /oname=$PLUGINSDIR\payload-manifest.json "${PROJECT_DIR}\build\portable-payload-x64.json"
    File /oname=$PLUGINSDIR\portable-payload.cjs "${PROJECT_DIR}\..\scripts\portable-payload.cjs"
    SetCompress auto
    ${if} ${Errors}
      StrCpy $PortableError "Unable to prepare embedded portable extraction files"
      Goto failed
    ${endIf}
    nsExec::ExecToStack /TIMEOUT=900000 '"$PLUGINSDIR\7za.exe" x "$PLUGINSDIR\payload.7z" "-o$PortableStage" -y -aoa -bso0 -bsp0'
    Pop $PortableStatus
    Pop $PortableOutput
    ${if} $PortableStatus != "0"
      StrCpy $PortableError "Portable extraction failed ($PortableStatus): $PortableOutput"
      Goto failed
    ${endIf}
    ReadEnvStr $PortableNodeMode ELECTRON_RUN_AS_NODE
    ReadEnvStr $PortableNodeOptions NODE_OPTIONS
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_OPTIONS", p0)'
    # Fixed script, independent quoted arguments; no shell evaluates paths.
    nsExec::ExecToStack /TIMEOUT=900000 '"$PortableStage\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\portable-payload.cjs" prepare "$PortableStage" "$INSTDIR" "$PLUGINSDIR\payload-manifest.json" "${VERSION}" "$PLUGINSDIR\payload-error.txt"'
    Pop $PortableStatus
    Pop $PortableOutput
    ${if} $PortableNodeMode == ""
      System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p0)'
    ${else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "$PortableNodeMode")'
    ${endIf}
    ${if} $PortableNodeOptions == ""
      System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_OPTIONS", p0)'
    ${else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_OPTIONS", w "$PortableNodeOptions")'
    ${endIf}
    ${if} $PortableStatus != "0"
      # Read the independent diagnostic channel if console pipe output was lost.
      IfFileExists "$PLUGINSDIR\payload-error.txt" 0 no_verifier_diagnostic
      FileOpen $0 "$PLUGINSDIR\payload-error.txt" r
      FileRead $0 $PortableOutput
      FileClose $0
      no_verifier_diagnostic:
      StrCpy $PortableError "Portable integrity verification failed ($PortableStatus): $PortableOutput"
      Goto failed
    ${endIf}
    # The verifier has exited, releasing executable handles. Atomic directory
    # rename publishes its complete validated tree and ready marker together.
    System::Call 'kernel32::MoveFileExW(w "\\?\$PortableStage", w "\\?\$INSTDIR", i 8) i.r0'
    ${if} $0 == 0
      StrCpy $PortableError "Unable to publish the verified portable cache"
      Goto failed
    ${endIf}

  runtime_ready:
    System::Call 'kernel32::ReleaseMutex(p $PortableMutex)'
    System::Call 'kernel32::CloseHandle(p $PortableMutex)'
    StrCpy $PortableMutex 0
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_APP_FILENAME", w "${APP_FILENAME}")'
    ${StdUtils.GetAllParameters} $R0 0
    !ifdef SPLASH_IMAGE
      BgImage::Destroy
    !endif
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R0' $0
    IfErrors failed
    SetErrorLevel $0
    Goto done

  failed:
    ${if} $PortableStage != ""
      # Best-effort cleanup of this launch's owned staging tree. Never touch
      # the published cache on failure or infer a deletion path from a log.
      RMDir /r "\\?\$PortableStage"
    ${endIf}
    ${if} $PortableMutex != 0
      System::Call 'kernel32::ReleaseMutex(p $PortableMutex)'
      System::Call 'kernel32::CloseHandle(p $PortableMutex)'
    ${endIf}
    CreateDirectory "$LOCALAPPDATA\Piora\portable"
    FileOpen $0 "$LOCALAPPDATA\Piora\portable\last-error.txt" w
    FileWrite $0 "$PortableError"
    FileClose $0
    !ifdef SPLASH_IMAGE
      BgImage::Destroy
    !endif
    SetErrorLevel 1
  done:
SectionEnd
