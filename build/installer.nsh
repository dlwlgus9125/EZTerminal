!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define EZ_SAS_POLICY_KEY "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
!define EZ_INSTALLER_STATE_KEY "SOFTWARE\EZTerminal\Installer"
!define EZ_FIREWALL_UDP "EZTerminal Remote Desktop UDP"
!define EZ_FIREWALL_WS "EZTerminal Remote Bridge TCP"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
  Var EzSasCheckbox
  Var EzSasConsent
  Var EzSasEligible

  Function EzSasPageCreate
    StrCpy $EzSasConsent 0
    StrCpy $EzSasEligible 1
    SetRegView 64
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "EditionID"
    StrCpy $1 $0 4
    StrCmp $1 "Core" 0 +2
      StrCpy $EzSasEligible 0

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 32u "Secure desktop control"
    Pop $0
    ${NSD_CreateLabel} 0 34u 100% 42u "EZTerminal can control the Windows lock and UAC desktops. On supported Pro, Enterprise, and Education editions, the option below also permits Ctrl+Alt+Delete from the connected phone."
    Pop $0
    ${NSD_CreateCheckbox} 0 82u 100% 24u "Allow the EZTerminal service to send Ctrl+Alt+Delete"
    Pop $EzSasCheckbox
    ${If} $EzSasEligible == 1
      ${NSD_Check} $EzSasCheckbox
      StrCpy $EzSasConsent 1
    ${Else}
      EnableWindow $EzSasCheckbox 0
      ${NSD_CreateLabel} 0 111u 100% 24u "This option is unavailable on Windows Home. Other PC control remains available."
      Pop $0
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function EzSasPageLeave
    ${If} $EzSasEligible == 1
      ${NSD_GetState} $EzSasCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $EzSasConsent 1
      ${Else}
        StrCpy $EzSasConsent 0
      ${EndIf}
    ${EndIf}
  FunctionEnd
  !endif
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom EzSasPageCreate EzSasPageLeave
!macroend

!macro customInit
  ; Stop the previous host before electron-builder replaces its executable.
  nsExec::ExecToLog 'sc.exe stop EZTerminalRemoteHost'

  ; One-time migration from the historical current-user Squirrel package.
  ; Its userData lives outside the app directory and is deliberately retained.
  IfFileExists "$LOCALAPPDATA\EZTerminal\Update.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\EZTerminal\Update.exe" --uninstall -s'
!macroend

!macro customInstall
  SetRegView 64

  ; Replace only the rules owned by this installer. Both are scoped to an
  ; exact executable and port; no router/NAT rule is created.
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${EZ_FIREWALL_UDP}"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall add rule name="${EZ_FIREWALL_UDP}" dir=in action=allow enable=yes profile=any protocol=UDP localport=7422 program="$INSTDIR\resources\ezterminal-remote-host.exe"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${EZ_FIREWALL_WS}"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall add rule name="${EZ_FIREWALL_WS}" dir=in action=allow enable=yes profile=any protocol=TCP localport=7420 program="$INSTDIR\EZTerminal.exe"'

  ${If} $EzSasConsent == 1
    ClearErrors
    ReadRegDWORD $0 HKLM "${EZ_SAS_POLICY_KEY}" "SoftwareSASGeneration"
    ${If} ${Errors}
      StrCpy $0 0
      WriteRegDWORD HKLM "${EZ_INSTALLER_STATE_KEY}" "SasPreviousExists" 0
    ${Else}
      WriteRegDWORD HKLM "${EZ_INSTALLER_STATE_KEY}" "SasPreviousExists" 1
    ${EndIf}
    WriteRegDWORD HKLM "${EZ_INSTALLER_STATE_KEY}" "SasPreviousValue" $0
    IntOp $1 $0 | 1
    WriteRegDWORD HKLM "${EZ_SAS_POLICY_KEY}" "SoftwareSASGeneration" $1
    WriteRegDWORD HKLM "${EZ_INSTALLER_STATE_KEY}" "SasWrittenValue" $1
  ${EndIf}

  ExecWait '"$INSTDIR\resources\ezterminal-remote-host.exe" --install-service' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "The EZTerminal Remote Desktop Host service could not be installed. PC Control will remain unavailable."
  ${Else}
    nsExec::ExecToLog 'sc.exe config EZTerminalRemoteHost start= delayed-auto'
  ${EndIf}
!macroend

!macro customUnInstall
  SetRegView 64
  IfFileExists "$INSTDIR\resources\ezterminal-remote-host.exe" 0 +2
    ExecWait '"$INSTDIR\resources\ezterminal-remote-host.exe" --uninstall-service'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${EZ_FIREWALL_UDP}"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${EZ_FIREWALL_WS}"'

  ; Restore the prior policy only when it still equals the value we wrote.
  ; A later administrator/domain change therefore always wins.
  ClearErrors
  ReadRegDWORD $0 HKLM "${EZ_INSTALLER_STATE_KEY}" "SasWrittenValue"
  ${IfNot} ${Errors}
    ClearErrors
    ReadRegDWORD $1 HKLM "${EZ_SAS_POLICY_KEY}" "SoftwareSASGeneration"
    ${IfNot} ${Errors}
      ${If} $0 == $1
        ReadRegDWORD $2 HKLM "${EZ_INSTALLER_STATE_KEY}" "SasPreviousExists"
        ${If} $2 == 1
          ReadRegDWORD $3 HKLM "${EZ_INSTALLER_STATE_KEY}" "SasPreviousValue"
          WriteRegDWORD HKLM "${EZ_SAS_POLICY_KEY}" "SoftwareSASGeneration" $3
        ${Else}
          DeleteRegValue HKLM "${EZ_SAS_POLICY_KEY}" "SoftwareSASGeneration"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  DeleteRegKey HKLM "${EZ_INSTALLER_STATE_KEY}"
!macroend
