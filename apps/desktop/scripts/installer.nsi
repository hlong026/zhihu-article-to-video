; 知乎文章转视频 Windows 安装器（NSIS 3.x，Unicode）
; 由 apps/desktop/scripts/package-desktop.mjs 调用 makensis 构建。
; 构建参数经 /D 传入：VERSION、SRC、OUT_FILE、ICON、EXE_NAME。
; 本文件以 UTF-8 BOM 保存，配合 Unicode true 正确显示中文。
;
; 升级安装支持：
;   - 自动检测已安装版本，复用原安装路径
;   - 安装前关闭正在运行的应用进程
;   - 版本比较，降级时给出提示
;   - 用户数据（AppData）不受安装/卸载影响

Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"

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

!define UNINST_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

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

; ─── 变量 ───────────────────────────────────────────────────────────────────
Var IsUpgrade          ; 是否为升级安装（"1" = 是）
Var InstalledVersion   ; 已安装的版本号

; ─── 安装向导界面（简体中文）─────────────────────────────────────────────────
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ─── 初始化：检测已安装版本 ─────────────────────────────────────────────────
Function .onInit
  StrCpy $IsUpgrade "0"
  StrCpy $InstalledVersion ""

  ; 从注册表读取已安装版本和路径
  ReadRegStr $InstalledVersion HKLM "${UNINST_REG_KEY}" "DisplayVersion"
  ReadRegStr $0 HKLM "${UNINST_REG_KEY}" "InstallLocation"

  ${If} $InstalledVersion != ""
    StrCpy $IsUpgrade "1"

    ; 复用原安装路径（若存在）
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}

    ; 版本不同则提示升级/降级信息
    ; /SD：静默安装（/S）时按默认答案继续，否则无人值守环境会弹窗挂起
    ${If} $InstalledVersion != "${VERSION}"
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "检测到已安装版本 $InstalledVersion。$\r$\n$\r$\n即将安装版本 ${VERSION}。$\r$\n$\r$\n您的任务数据和生成产物不会受到影响。$\r$\n$\r$\n点击“确定”继续，“取消”退出。" /SD IDOK IDOK doContinue
      Abort
      doContinue:
    ${EndIf}
  ${EndIf}
FunctionEnd

; ─── 关闭正在运行的应用进程 ─────────────────────────────────────────────────
Function CloseRunningApp
  ; 尝试优雅关闭：通过 FindWindow 发送 WM_CLOSE
  FindWindow $0 "${DISPLAY_NAME}" ""
  ${If} $0 != 0
    SendMessage $0 0x0010 0 0  ; WM_CLOSE
    Sleep 1500
  ${EndIf}

  ; 若进程仍在运行，强制结束
  nsExec::ExecToLog 'taskkill /F /IM "${EXE_NAME}" /T'
  Sleep 500
FunctionEnd

; ─── 安装主体 ───────────────────────────────────────────────────────────────
Section "Install"
  ; 升级时先关闭运行中的应用
  ${If} $IsUpgrade == "1"
    Call CloseRunningApp
  ${EndIf}

  SetOutPath $INSTDIR
  File /r "${SRC}\*.*"

  ; 开始菜单与桌面快捷方式
  CreateDirectory "$SMPROGRAMS\${DISPLAY_NAME}"
  CreateShortCut "$SMPROGRAMS\${DISPLAY_NAME}\${DISPLAY_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  CreateShortCut "$SMPROGRAMS\${DISPLAY_NAME}\卸载 ${DISPLAY_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${DISPLAY_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 注册到"程序和功能"（Add/Remove Programs）
  WriteRegStr HKLM "${UNINST_REG_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKLM "${UNINST_REG_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINST_REG_KEY}" "DisplayIcon" "$INSTDIR\${EXE_NAME}"
  WriteRegStr HKLM "${UNINST_REG_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_REG_KEY}" "Publisher" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${UNINST_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINST_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_REG_KEY}" "NoRepair" 1
SectionEnd

; ─── 卸载（不删除用户数据）──────────────────────────────────────────────────
Section "Uninstall"
  ; 关闭运行中的应用
  Call un.CloseRunningApp

  ; 仅删除程序文件，不触碰 AppData 中的用户数据
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\${DISPLAY_NAME}\${DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\卸载 ${DISPLAY_NAME}.lnk"
  RMDir "$SMPROGRAMS\${DISPLAY_NAME}"
  Delete "$DESKTOP\${DISPLAY_NAME}.lnk"

  DeleteRegKey HKLM "${UNINST_REG_KEY}"

  ; 提示用户数据保留位置（/SD：静默卸载时跳过弹窗，CI 冒烟曾因此挂满 6 小时）
  MessageBox MB_OK|MB_ICONINFORMATION "程序已卸载。$\r$\n$\r$\n您的任务数据仍保留在：$\r$\n%APPDATA%\${PRODUCT_NAME}$\r$\n$\r$\n如不再需要，可手动删除该文件夹。" /SD IDOK
SectionEnd

; ─── 卸载时关闭进程 ─────────────────────────────────────────────────────────
Function un.CloseRunningApp
  FindWindow $0 "${DISPLAY_NAME}" ""
  ${If} $0 != 0
    SendMessage $0 0x0010 0 0
    Sleep 1500
  ${EndIf}
  nsExec::ExecToLog 'taskkill /F /IM "${EXE_NAME}" /T'
  Sleep 500
FunctionEnd
