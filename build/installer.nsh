; Extra steps for the Windows installer (electron-builder includes this).
; The Start menu entry is always made; the desktop shortcut is a checkbox on
; the last page, checked by default.
; The installer's last page (replaces electron-builder's, same Run checkbox).
; The shortcut checkbox settings are removed again after the page, so the
; uninstaller's last page does not pick them up.
!macro customFinishPage
  Function CreateIlluminatorDesktopShortcut
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
  FunctionEnd

  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateIlluminatorDesktopShortcut
  !insertmacro MUI_PAGE_FINISH
  !undef MUI_FINISHPAGE_SHOWREADME
  !undef MUI_FINISHPAGE_SHOWREADME_TEXT
  !undef MUI_FINISHPAGE_SHOWREADME_FUNCTION
  !undef MUI_FINISHPAGE_RUN
  !undef MUI_FINISHPAGE_RUN_FUNCTION
!macroend

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
