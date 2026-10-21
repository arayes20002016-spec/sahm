!include "nsDialogs.nsh"
!define MUI_LANGDLL_WINDOWTITLE "SAHM — Language"
LangString SahmConsentTitle 1025 "تكامل سَهم مع المتصفح"
LangString SahmConsentTitle 1033 "SAHM browser integration"
LangString SahmConsentSubtitle 1025 "اختر ما إذا كنت تريد إعداد Chrome وEdge بعد التثبيت."
LangString SahmConsentSubtitle 1033 "Choose whether to set up Chrome and Edge after installation."
LangString SahmConsentBody 1025 "يمكن لسَهم إظهار زر لتنزيل الفيديو والتقاط التنزيلات من المتصفح.$\r$\n$\r$\nعند توفر الإضافة في المتجر، يفتح سَهم صفحتها لتوافق على صلاحياتها داخل المتصفح. إذا لم تُنشر بعد، يوضح التطبيق ذلك ويعرض الإعداد التجريبي اليدوي."
LangString SahmConsentBody 1033 "SAHM can show a video download button and capture browser downloads.$\r$\n$\r$\nWhen a store release is available, SAHM opens its page for you to approve permissions in the browser. Otherwise, the app explains that publication is pending and shows manual trial setup."
LangString SahmConsentCheck 1025 "أوافق على بدء إعداد تكامل Chrome وEdge بعد التثبيت."
LangString SahmConsentCheck 1033 "Start Chrome and Edge integration setup after installation."
LangString SahmConsentHint 1025 "يمكنك تخطي هذه الخطوة وإعداد التكامل لاحقًا من سَهم. تنزيلات الجلسات وPOST لها خيارات مستقلة داخل التطبيق والإضافة."
LangString SahmConsentHint 1033 "You can skip this step and set up integration later in SAHM. Session and POST capture have separate settings in the app and extension."
LangString SahmRun 1025 "تشغيل سَهم"
LangString SahmRun 1033 "Run SAHM"
LangString SahmCleanupError 1025 "تعذّر تنظيف اتصال المتصفح أو بدء التشغيل. بقيت ملفات سَهم محفوظة؛ أعد محاولة الإزالة.$\r$\nسجل الخطأ: $TEMP\SAHM-uninstall-last-error.log"
LangString SahmCleanupError 1033 "Could not remove browser integration or startup registration. SAHM files were retained; retry uninstalling.$\r$\nError log: $TEMP\SAHM-uninstall-last-error.log"


!include "${BUILD_RESOURCES_DIR}\process-control.nsh"

; The installer never registers browser hosts itself. Only this explicit choice
; adds --setup-browser when the user launches SAHM from the Finish page.
!ifndef BUILD_UNINSTALLER
  Var SahmBrowserConsent
  Var SahmBrowserCheckbox
  Var SahmBrowserPage

  !macro customInit
    StrCpy $SahmBrowserConsent ${BST_UNCHECKED}
    ; SAHM's integration and data belong to the current Windows user.
    StrCpy $hasPerMachineInstallation "0"
    StrCpy $hasPerUserInstallation "1"
    !insertmacro setInstallModePerUser
  !macroend

  !macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
  !macroend

  !macro customPageAfterChangeDir
    Page custom SahmBrowserConsentCreate SahmBrowserConsentLeave

  Function SahmBrowserConsentCreate
    !insertmacro MUI_HEADER_TEXT "$(SahmConsentTitle)" "$(SahmConsentSubtitle)"
    nsDialogs::Create 1018
    Pop $SahmBrowserPage
    ${If} $SahmBrowserPage == error
      Abort
    ${EndIf}
    ${If} $LANGUAGE == 1025
      nsDialogs::SetRTL 1
    ${Else}
      nsDialogs::SetRTL 0
    ${EndIf}

    ${NSD_CreateLabel} 0u 0u 100% 52u "$(SahmConsentBody)"
    Pop $0
    ${NSD_CreateCheckbox} 0u 67u 100% 30u "$(SahmConsentCheck)"
    Pop $SahmBrowserCheckbox
    ${NSD_SetState} $SahmBrowserCheckbox $SahmBrowserConsent
    ${NSD_CreateLabel} 0u 111u 100% 37u "$(SahmConsentHint)"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function SahmBrowserConsentLeave
    ${NSD_GetState} $SahmBrowserCheckbox $SahmBrowserConsent
  FunctionEnd
  !macroend

  !macro customFinishPage
    Function StartApp
      StrCpy $1 ""
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${EndIf}
      ${If} $SahmBrowserConsent == ${BST_CHECKED}
        StrCpy $1 "$1 --setup-browser"
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "$(SahmRun)"
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  !macro customUnInstall
    ${IfNot} ${isUpdated}
      ReadEnvStr $R6 "ELECTRON_RUN_AS_NODE"
      System::Call 'Kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")i.r0'
      ClearErrors
      ExecWait '"$INSTDIR\SAHM.exe" "$INSTDIR\resources\app.asar\electron\uninstall-integration.cjs" "$INSTDIR"' $R7
      ${If} ${Errors}
        StrCpy $R7 "launch-error"
      ${EndIf}
      ${If} $R6 == ""
        System::Call 'Kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)i.r0'
      ${Else}
        System::Call 'Kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "$R6")i.r0'
      ${EndIf}
      ${If} $R7 != 0
        FileOpen $R9 "$TEMP\SAHM-uninstall-last-error.log" w
        FileWrite $R9 "Cleanup exit: $R7$\r$\nResult: $TEMP\SAHM-uninstall-last-result.json$\r$\n"
        FileClose $R9
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(SahmCleanupError)" /SD IDOK
        SetErrorLevel 1
        Abort
      ${EndIf}
    ${EndIf}
  !macroend
!endif
