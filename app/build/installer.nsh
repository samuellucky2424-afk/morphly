!macro customInstall
  ; Remove the retired Morphly DirectShow/Media Foundation camera during an
  ; in-place upgrade while its old registrar is still available.
  IfFileExists "$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" 0 legacyCameraCleanupDone
  DetailPrint "Removing the retired Morphly camera implementation..."
  nsExec::ExecToLog '"$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" remove --all-users --unregister-com'
  Pop $0

legacyCameraCleanupDone:
  Delete "$INSTDIR\resources\morphly-cam\morphly_cam_pipe_publisher.exe"
  Delete "$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe"
  Delete "$INSTDIR\resources\morphly-cam\MorphlyVirtualCamera.dll"
  Delete "$INSTDIR\resources\morphly-cam\MorphlyVirtualCameraMF.dll"
  RMDir "$INSTDIR\resources\morphly-cam"

  IfFileExists "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll" 0 unityCaptureInstallFailed
  IfFileExists "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll" 0 unityCaptureInstallFailed

  DetailPrint "Registering Morphly Virtual Camera with UnityCapture..."
  IfFileExists "$WINDIR\SysWOW64\regsvr32.exe" 0 unityCaptureRegister32System
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll" "/i:UnityCaptureName=Morphly Virtual Camera"'
  Pop $0
  Goto unityCaptureRegister64

unityCaptureRegister32System:
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll" "/i:UnityCaptureName=Morphly Virtual Camera"'
  Pop $0

unityCaptureRegister64:
  IfFileExists "$WINDIR\Sysnative\regsvr32.exe" 0 unityCaptureRegister64System
  nsExec::ExecToLog '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll" "/i:UnityCaptureName=Morphly Virtual Camera"'
  Pop $1
  Goto unityCaptureCheckResult

unityCaptureRegister64System:
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll" "/i:UnityCaptureName=Morphly Virtual Camera"'
  Pop $1

unityCaptureCheckResult:
  StrCmp $0 "0" 0 unityCaptureInstallFailed
  StrCmp $1 "0" customInstallDone unityCaptureInstallFailed

unityCaptureInstallFailed:
  MessageBox MB_ICONEXCLAMATION|MB_OK "Morphly Desktop was installed, but Morphly Virtual Camera could not be registered.$\r$\n$\r$\nPlease reinstall Morphly Desktop as Administrator.$\r$\n$\r$\n32-bit exit code: $0$\r$\n64-bit exit code: $1"

customInstallDone:
!macroend

!macro customUnInstall
  DetailPrint "Removing Morphly Virtual Camera..."

  IfFileExists "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll" 0 unityCaptureUnregister64
  IfFileExists "$WINDIR\SysWOW64\regsvr32.exe" 0 unityCaptureUnregister32System
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s /u "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll"'
  Pop $0
  Goto unityCaptureUnregister64

unityCaptureUnregister32System:
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s /u "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll"'
  Pop $0

unityCaptureUnregister64:
  IfFileExists "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll" 0 customUnInstallDone
  IfFileExists "$WINDIR\Sysnative\regsvr32.exe" 0 unityCaptureUnregister64System
  nsExec::ExecToLog '"$WINDIR\Sysnative\regsvr32.exe" /s /u "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll"'
  Pop $1
  Goto customUnInstallDone

unityCaptureUnregister64System:
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s /u "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll"'
  Pop $1

customUnInstallDone:
!macroend
