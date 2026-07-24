!include "LogicLib.nsh"

!define EZ_SAS_POLICY_KEY "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
!define EZ_INSTALLER_STATE_KEY "SOFTWARE\EZTerminal\Installer"
!define EZ_FIREWALL_UDP "EZTerminal Remote Desktop UDP"
!define EZ_FIREWALL_WS "EZTerminal Remote Bridge TCP"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; 1.0.x does not support software SAS or secure-desktop input. Undo only the
; exact legacy installer value when no administrator/domain policy changed it.
!macro RestoreLegacyEzSasPolicy
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
  !insertmacro RestoreLegacyEzSasPolicy

  ; Replace only the rules owned by this installer. Both are scoped to an
  ; exact executable and port; no router/NAT rule is created.
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${EZ_FIREWALL_UDP}"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall add rule name="${EZ_FIREWALL_UDP}" dir=in action=allow enable=yes profile=any protocol=UDP localport=7422 program="$INSTDIR\resources\ezterminal-remote-host.exe"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${EZ_FIREWALL_WS}"'
  nsExec::ExecToLog 'netsh.exe advfirewall firewall add rule name="${EZ_FIREWALL_WS}" dir=in action=allow enable=yes profile=any protocol=TCP localport=7420 program="$INSTDIR\EZTerminal.exe"'

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
  !insertmacro RestoreLegacyEzSasPolicy
!macroend
