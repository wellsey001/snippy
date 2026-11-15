; Snippy installer additions (included by electron-builder).
;
; Remember how Snippy was installed: if it's already installed for all users (or just for you),
; installing again or updating keeps that, without asking. The first install still asks.
!macro customInstallMode
  ReadRegStr $R8 HKLM64 "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 == ""
    ReadRegStr $R8 HKLM32 "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endif}
  ${if} $R8 != ""
    StrCpy $isForceMachineInstall "1"
  ${else}
    ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R8 != ""
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend
