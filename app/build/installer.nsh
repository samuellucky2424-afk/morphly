!macro customInstall
  IfFileExists "$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" 0 customInstallDone

  DetailPrint "Installing Morphly virtual camera..."
  nsExec::ExecToLog '"$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" install --all-users'
  Pop $0

  StrCmp $0 "0" customInstallDone
  MessageBox MB_ICONEXCLAMATION|MB_OK "Morphly Desktop was installed, but the Morphly virtual camera setup failed with exit code $0.$\r$\n$\r$\nYou can retry manually from:$\r$\n$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe install --all-users"

customInstallDone:
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" 0 customUnInstallDone

  DetailPrint "Removing Morphly virtual camera..."
  nsExec::ExecToLog '"$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" remove --all-users --unregister-com'
  Pop $0

customUnInstallDone:
!macroend