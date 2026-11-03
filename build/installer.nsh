; Extra steps for the Windows installer (electron-builder includes this).
; The Start menu entry is always made. The desktop shortcut is a checkbox,
; "Add to desktop", on a page of its own after the folder page (ticked by
; default; skipped when the app updates itself, which keeps what is there).

!include nsDialogs.nsh

; Only the installer has the page (the uninstaller build would warn about unused variables, which electron-builder treats as errors).
!ifndef BUILD_UNINSTALLER
  Var AddToDesktopBox
  Var AddToDesktop
!endif

!macro customPageAfterChangeDir
  Page custom AddToDesktopPage AddToDesktopLeave

  Function AddToDesktopPage
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where to put Illuminator."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 8u 100% 12u "Add to desktop"
    Pop $AddToDesktopBox
    ${NSD_Check} $AddToDesktopBox
    ${NSD_CreateLabel} 12u 24u 90% 24u "Puts an Illuminator shortcut on the desktop. The Start menu entry is always made."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function AddToDesktopLeave
    ${NSD_GetState} $AddToDesktopBox $AddToDesktop
  FunctionEnd
!macroend

!macro customInstall
  ${if} $AddToDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
  ${endif}
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
