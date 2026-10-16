; Extra steps for the Windows installer (electron-builder includes this).
; The Start menu entry is always made; the desktop shortcut is a checkbox on
; the last page, checked by default.
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateIlluminatorDesktopShortcut

Function CreateIlluminatorDesktopShortcut
  CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
FunctionEnd

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
