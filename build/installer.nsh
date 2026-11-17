; DeepDock NSIS tweaks (electron-builder auto-includes build/installer.nsh).
;
; - installs an extra "卸载 DeepDock" shortcut into the Start Menu folder, so the
;   uninstaller is easy to find next to the app shortcut;
; - during uninstall, asks whether the local conversations/projects/settings in
;   %APPDATA%\DeepDock should be removed too (default: keep them).

!macro customInstall
  CreateDirectory "$SMPROGRAMS\DeepDock"
  CreateShortCut "$SMPROGRAMS\DeepDock\卸载 DeepDock.lnk" "$INSTDIR\Uninstall DeepDock.exe"
!macroend

!macro customUnInstall
  ; Auto-update and silent reinstalls run the uninstaller with /S: never prompt
  ; there, and keep the user's data untouched.
  IfSilent deepdock_keep_data

  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本机的对话、项目和设置数据？$\r$\n$\r$\n数据目录：$APPDATA\DeepDock$\r$\n$\r$\n选择「否」会保留这些数据，之后重装 DeepDock 还能接着用。" /SD IDNO IDYES deepdock_remove_data IDNO deepdock_keep_data

  deepdock_remove_data:
    RMDir /r "$APPDATA\DeepDock"
    Goto deepdock_uninstall_done

  deepdock_keep_data:
    ; keep %APPDATA%\DeepDock as-is

  deepdock_uninstall_done:
!macroend
