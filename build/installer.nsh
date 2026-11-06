; Extra steps for the Windows installer (electron-builder includes this).
; The Start menu entry is always made. The desktop shortcut is a checkbox, "Add Illuminator to the desktop", on the last page
; beside "Run Illuminator" (both ticked by default). Updates and silent installs never show that page, so they keep what is there.

!include nsDialogs.nsh

; The installer's last page (replaces electron-builder's, which has only the "Run" checkbox: the same function and settings, plus the second checkbox).
!ifndef BUILD_UNINSTALLER
  !macro customFinishPage
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    Function AddToDesktop
      CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_SHOWREADME
    !define MUI_FINISHPAGE_SHOWREADME_TEXT "Add Illuminator to the desktop"
    !define MUI_FINISHPAGE_SHOWREADME_FUNCTION AddToDesktop
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
!macroend

; Install under Program Files (all users) by default, not the per-user
; AppData folder; the user can still pick another folder on the directory page.
!macro customInit
  ${If} $INSTDIR == ""
  ${OrIf} $INSTDIR == "$LOCALAPPDATA\Programs\${PRODUCT_FILENAME}"
    StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCT_FILENAME}"
  ${EndIf}
!macroend
