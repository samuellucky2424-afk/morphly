!macro customInstall
  StrCpy $0 "not run"
  StrCpy $1 "not run"
  StrCpy $R0 "not run"
  StrCpy $R1 "not run"

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

unityCaptureInstallRetry:
  IfFileExists "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll" 0 unityCaptureInstallFailed
  IfFileExists "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll" 0 unityCaptureInstallFailed

  DetailPrint "Registering Morphly Virtual Camera with UnityCapture..."
  IfFileExists "$WINDIR\SysWOW64\regsvr32.exe" 0 unityCaptureRegister32System
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s "/i:UnityCaptureName=Morphly Virtual Camera" "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll"'
  Pop $0
  Goto unityCaptureRegister64

unityCaptureRegister32System:
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s "/i:UnityCaptureName=Morphly Virtual Camera" "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll"'
  Pop $0

unityCaptureRegister64:
  IfFileExists "$WINDIR\Sysnative\regsvr32.exe" 0 unityCaptureRegister64System
  nsExec::ExecToLog '"$WINDIR\Sysnative\regsvr32.exe" /s "/i:UnityCaptureName=Morphly Virtual Camera" "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll"'
  Pop $1
  Goto unityCaptureCheckResult

unityCaptureRegister64System:
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s "/i:UnityCaptureName=Morphly Virtual Camera" "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll"'
  Pop $1

unityCaptureCheckResult:
  StrCmp $0 "0" 0 unityCaptureInstallFailed
  StrCmp $1 "0" 0 unityCaptureInstallFailed

  ; regsvr32 returning success is not enough for a release installer. Verify
  ; that both COM registrations exist and point to DLLs that Windows can load.
  SetRegView 32
  ReadRegStr $4 HKLM "SOFTWARE\Classes\CLSID\{5C2CD55C-92AD-4999-8666-912BD3E70020}" ""
  StrCmp $4 "Morphly Virtual Camera" 0 unityCaptureInstallFailed
  ReadRegStr $2 HKLM "SOFTWARE\Classes\CLSID\{5C2CD55C-92AD-4999-8666-912BD3E70020}\InprocServer32" ""
  StrCmp $2 "$INSTDIR\resources\unity-capture\UnityCaptureFilter32.dll" 0 unityCaptureInstallFailed
  IfFileExists "$2" 0 unityCaptureInstallFailed
  ReadRegStr $6 HKLM "SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{5C2CD55C-92AD-4999-8666-912BD3E70020}" "FriendlyName"
  StrCmp $6 "Morphly Virtual Camera" 0 unityCaptureInstallFailed
  ReadRegStr $8 HKLM "SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{5C2CD55C-92AD-4999-8666-912BD3E70020}" "CLSID"
  StrCmp $8 "{5C2CD55C-92AD-4999-8666-912BD3E70020}" 0 unityCaptureInstallFailed

  SetRegView 64
  ReadRegStr $5 HKLM "SOFTWARE\Classes\CLSID\{5C2CD55C-92AD-4999-8666-912BD3E70010}" ""
  StrCmp $5 "Morphly Virtual Camera" 0 unityCaptureInstallFailed
  ReadRegStr $3 HKLM "SOFTWARE\Classes\CLSID\{5C2CD55C-92AD-4999-8666-912BD3E70010}\InprocServer32" ""
  StrCmp $3 "$INSTDIR\resources\unity-capture\UnityCaptureFilter64.dll" 0 unityCaptureInstallFailed
  IfFileExists "$3" 0 unityCaptureInstallFailed
  ReadRegStr $7 HKLM "SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{5C2CD55C-92AD-4999-8666-912BD3E70010}" "FriendlyName"
  StrCmp $7 "Morphly Virtual Camera" 0 unityCaptureInstallFailed
  ReadRegStr $9 HKLM "SOFTWARE\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{5C2CD55C-92AD-4999-8666-912BD3E70010}" "CLSID"
  StrCmp $9 "{5C2CD55C-92AD-4999-8666-912BD3E70010}" 0 unityCaptureInstallFailed
  Goto mediaFoundationInstall

unityCaptureInstallFailed:
  SetRegView 64
  MessageBox MB_ICONSTOP|MB_RETRYCANCEL "Morphly Virtual Camera could not be registered and verified.$\r$\n$\r$\nMorphly will not finish installation without both the 32-bit and 64-bit camera components.$\r$\n$\r$\n32-bit exit code: $0$\r$\n64-bit exit code: $1" /SD IDCANCEL IDRETRY unityCaptureInstallRetry
  DetailPrint "Morphly Virtual Camera registration failed; stopping installation with error 1603."
  SetErrorLevel 1603
  Quit

mediaFoundationInstall:
  ; MFCreateVirtualCamera is available starting with Windows 11 build 22000.
  ; Do not fail a Windows 10 installation because this API cannot load there.
  ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  IntCmp $R2 22000 mediaFoundationInstallSupported mediaFoundationUnsupported mediaFoundationInstallSupported
mediaFoundationUnsupported:
  DetailPrint "Windows 10: legacy camera registered; modern MF camera requires Windows 11."
  Goto vbCableInstall
mediaFoundationInstallSupported:
  IfFileExists "$INSTDIR\resources\media-foundation-camera\morphly_cam_registrar.exe" 0 mediaFoundationInstallFailed
  IfFileExists "$INSTDIR\resources\media-foundation-camera\MorphlyVirtualCameraMF.dll" 0 mediaFoundationInstallFailed

mediaFoundationInstallRetry:
  DetailPrint "Registering the Media Foundation camera for WhatsApp and modern Windows apps..."
  nsExec::ExecToLog '"$INSTDIR\resources\media-foundation-camera\morphly_cam_registrar.exe" install --all-users'
  Pop $R0
  StrCmp $R0 "0" 0 mediaFoundationInstallFailed

  ; Registration checks must not contend with WhatsApp for a live camera stream.
  nsExec::ExecToLog '"$INSTDIR\resources\media-foundation-camera\morphly_cam_registrar.exe" probe-registration'
  Pop $R1
  StrCmp $R1 "0" vbCableInstall mediaFoundationInstallFailed

mediaFoundationInstallFailed:
  MessageBox MB_ICONSTOP|MB_RETRYCANCEL "Morphly's WhatsApp-compatible camera could not be registered and verified.$\r$\n$\r$\nExit code: $R0$\r$\nVerification code: $R1" /SD IDCANCEL IDRETRY mediaFoundationInstallRetry
  DetailPrint "Media Foundation virtual camera registration failed; stopping installation with error 1603."
  SetErrorLevel 1603
  Quit

vbCableInstall:
  DetailPrint "Checking VB-Audio Virtual Cable installation..."
  SetRegView 64
  ReadRegStr $2 HKLM "SOFTWARE\VB-Audio\Cable" "InstallDir"
  StrCmp $2 "" 0 vbCableAlreadyInstalled

  IfFileExists "$INSTDIR\resources\vbcable\VBCABLE_Setup_x64.exe" 0 customInstallDone
  DetailPrint "Installing VB-Audio Virtual Cable for voice changer..."
  nsExec::ExecToLog '"$INSTDIR\resources\vbcable\VBCABLE_Setup_x64.exe" -i -h'
  Pop $0
  DetailPrint "VB-Audio Virtual Cable install exit code: $0"
  Goto customInstallDone

vbCableAlreadyInstalled:
  DetailPrint "VB-Audio Virtual Cable is already installed."

customInstallDone:
  SetRegView 64
  DetailPrint "Morphly Virtual Camera registration verified for 32-bit and 64-bit applications."
!macroend

!macro customUnInstall
  ; The incoming installer refreshes registrations. Removing system-lifetime
  ; camera devices during an update can leave other apps with stale identities.
  ${if} ${isUpdated}
    DetailPrint "Preserving Morphly camera registrations during update."
    Goto customUnInstallDone
  ${endif}
  DetailPrint "Removing Morphly Virtual Camera..."

  IfFileExists "$INSTDIR\resources\media-foundation-camera\morphly_cam_registrar.exe" 0 mediaFoundationUnregisterDone
  nsExec::ExecToLog '"$INSTDIR\resources\media-foundation-camera\morphly_cam_registrar.exe" remove --all-users --unregister-com'
  Pop $R0

mediaFoundationUnregisterDone:

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
