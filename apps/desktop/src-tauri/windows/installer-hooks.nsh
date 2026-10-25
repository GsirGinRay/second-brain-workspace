; 0.9.0 renamed the product from "Second Brain Workspace" to "aizbrain".
; NSIS keys the install folder and the Apps list entry by product name, so
; without this hook an update would leave the old copy installed next to the
; new one. Remove the old per-user install silently (app data is kept; it is
; stored under the unchanged identifier) and move the autostart entry.

!include LogicLib.nsh

!ifndef LEGACY_PRODUCTNAME
  !define LEGACY_PRODUCTNAME "Second Brain Workspace"
!endif
!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_PRODUCTNAME}"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "${LEGACY_UNINSTKEY}" "UninstallString"
  ReadRegStr $R1 HKCU "${LEGACY_UNINSTKEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
    ; InstallLocation is stored with quotes; _?= needs the bare folder.
    StrCpy $R2 $R1 1
    ${If} $R2 == '"'
      StrCpy $R1 $R1 "" 1
      StrCpy $R1 $R1 -1
    ${EndIf}
    ${If} $R1 != $INSTDIR
      ExecWait '$R0 /S _?=$R1'
      Delete "$R1\uninstall.exe"
      RMDir "$R1"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SecondBrainWorkspace"
  ${If} $R0 != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SecondBrainWorkspace" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
!macroend
