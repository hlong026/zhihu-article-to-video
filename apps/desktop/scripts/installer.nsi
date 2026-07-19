; 知乎文章转视频 Windows 安装器（NSIS 3.x，Unicode）
; 由 apps/desktop/scripts/package-desktop.mjs 调用 makensis 构建。
; 构建参数经 /D 传入：VERSION、SRC、OUT_FILE、ICON、EXE_NAME。
; 本文件以 UTF-8 BOM 保存，配合 Unicode true 正确显示中文。

Unicode true

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.1"
!endif
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "ZhihuArticleToVideo"
!endif
!ifndef DISPLAY_NAME
  !define DISPLAY_NAME "知乎文章转视频"
!endif
!ifndef EXE_NAME
  !define EXE_NAME "ZhihuArticleToVideo.exe"
!endif
!ifndef SRC
  !define SRC "..\out\win32\ZhihuArticleToVideo"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\out\win32\ZhihuArticleToVideo-win32-x64-Setup.exe"
!endif

Name "${DISPLAY_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

; 安装包与卸载程序图标
!ifdef ICON
  Icon "${ICON}"
  UninstallIcon "${ICON}"
!endif

; 安装包属性中的版本信息
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${DISPLAY_NAME}"
VIAddVersionKey "FileDescription" "${DISPLAY_NAME} 安装程序"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "LegalCopyright" "Copyright (c) ${PRODUCT_NAME}"

; 安装向导界面（简体中文）
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath $INSTDIR
  File /r "${SRC}\*.*"

  ; 开始菜单与桌面快捷方式
  CreateDirectory "$SMPROGRAMS\${DISPLAY_NAME}"
  CreateShortCut "$SMPROGRAMS\${DISPLAY_NAME}\${DISPLAY_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  CreateShortCut "$SMPROGRAMS\${DISPLAY_NAME}\卸载 ${DISPLAY_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${DISPLAY_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 注册到“程序和功能”（Add/Remove Programs）
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayIcon" "$INSTDIR\${EXE_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "Publisher" "${PRODUCT_NAME}"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\${DISPLAY_NAME}\${DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\卸载 ${DISPLAY_NAME}.lnk"
  RMDir "$SMPROGRAMS\${DISPLAY_NAME}"
  Delete "$DESKTOP\${DISPLAY_NAME}.lnk"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
SectionEnd
