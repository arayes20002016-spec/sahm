LangString SahmProcessRunning 1025 "سَهم يعمل. سيُغلق لإكمال التثبيت أو الإزالة. تُحفظ التنزيلات ونقاط الاستئناف الموجودة على القرص."
LangString SahmProcessRunning 1033 "SAHM is running. It will close to complete installation or removal. Downloads and resume checkpoints already saved on disk are retained."
LangString SahmProcessFailed 1025 "تعذّر إغلاق نسخة سَهم في مسار هذا التثبيت. أغلقها من أيقونتها بجوار الساعة ثم أعد المحاولة."
LangString SahmProcessFailed 1033 "Could not close SAHM at this installation path. Exit from its system tray icon, then retry."
!ifndef SAHM_PROCESS_CONTROL_INCLUDED
!define SAHM_PROCESS_CONTROL_INCLUDED
Var SahmProcessAction
Var SahmProcessResult
Var SahmProcessCanStop
Var SahmExpectedProcessPath
Var SahmProcessAttempts
!ifdef BUILD_UNINSTALLER
  !define SAHM_PROCESS_FUNCTION un.SahmCheckProcesses
!else
  !define SAHM_PROCESS_FUNCTION SahmCheckProcesses
!endif

!macro SahmProcessLog TEXT
  Push $0
  ClearErrors
  FileOpen $0 "$TEMP\SAHM-process-control.log" a
  ${IfNot} ${Errors}
    FileSeek $0 0 END
    FileWrite $0 "${TEXT}$\r$\n"
    FileClose $0
  ${EndIf}
  ClearErrors
  Pop $0
!macroend

; Keep the same handle for path validation and termination; never match by name.
Function ${SAHM_PROCESS_FUNCTION}
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $1 0
  StrCpy $6 0
  StrCpy $9 0
  GetFullPathName $SahmExpectedProcessPath "$INSTDIR\${APP_FILENAME}.exe"
  System::Alloc 65536
  Pop $1
  ${If} $1 == 0
    StrCpy $9 -1
    Goto sahm_process_done
  ${EndIf}
  System::Call 'kernel32::K32EnumProcesses(p r1, i 65536, *i .r2) i.r0'
  ${If} $0 == 0
  ${OrIf} $2 == 0
  ${OrIf} $2 >= 65536
    !insertmacro SahmProcessLog "enumeration-failed result=$0 bytes=$2"
    StrCpy $9 -1
    Goto sahm_process_done
  ${EndIf}
  StrCpy $3 $1
  IntOp $4 $1 + $2
  sahm_process_next:
    IntCmpU $3 $4 sahm_process_done 0 sahm_process_done
    System::Call '*$3(i .r5)'
    IntOp $3 $3 + 4
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    ${If} $5 == 0
    ${OrIf} $5 == $0
      Goto sahm_process_next
    ${EndIf}
    ; QUERY_LIMITED_INFORMATION | SYNCHRONIZE | TERMINATE, without elevation.
    System::Call 'kernel32::OpenProcess(i 0x101001, i 0, i r5) p.r6'
    StrCpy $SahmProcessCanStop 1
    ${If} $6 == 0
      System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r5) p.r6'
      StrCpy $SahmProcessCanStop 0
    ${EndIf}
    ${If} $6 == 0
      Goto sahm_process_next
    ${EndIf}
    StrCpy $8 ${NSIS_MAX_STRLEN}
    System::Call 'kernel32::QueryFullProcessImageNameW(p r6, i 0, w .r7, *i r8) i.r0'
    ${If} $0 != 0
    ${AndIf} $7 == $SahmExpectedProcessPath
      IntOp $9 $9 + 1
      !insertmacro SahmProcessLog "matched pid=$5 action=$SahmProcessAction can-stop=$SahmProcessCanStop"
      ${If} $SahmProcessAction == "stop"
        ; Sandboxed children can deny TERMINATE while their broker is still alive.
        ; Visit every matching process, then let the caller verify none remain.
        ${If} $SahmProcessCanStop != 0
          System::Call 'kernel32::WaitForSingleObject(p r6, i 0) i.r0'
          ${If} $0 != 0
            System::Call 'kernel32::TerminateProcess(p r6, i 0) i.r0'
            ; A child may already be exiting after its parent was stopped.
            System::Call 'kernel32::WaitForSingleObject(p r6, i 5000) i.r0'
            ${If} $0 != 0
              !insertmacro SahmProcessLog "stop-pending pid=$5 wait=$0"
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r6)'
    StrCpy $6 0
    Goto sahm_process_next
  sahm_process_done:
    ${If} $6 != 0
      System::Call 'kernel32::CloseHandle(p r6)'
    ${EndIf}
    ${If} $1 != 0
      System::Free $1
    ${EndIf}
    StrCpy $SahmProcessResult $9
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro customCheckAppRunning
  !insertmacro SahmProcessLog "check-start"
  StrCpy $SahmProcessAction "check"
  Call ${SAHM_PROCESS_FUNCTION}
  !insertmacro SahmProcessLog "check-result $SahmProcessResult"
  ${If} $SahmProcessResult > 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(SahmProcessRunning)" /SD IDOK IDOK +2
    Quit
    StrCpy $SahmProcessAction "stop"
    Call ${SAHM_PROCESS_FUNCTION}
    !insertmacro SahmProcessLog "stop-result $SahmProcessResult"
    ${If} $SahmProcessResult >= 0
      StrCpy $SahmProcessAttempts 0
      sahm_process_recheck:
        StrCpy $SahmProcessAction "check"
        Call ${SAHM_PROCESS_FUNCTION}
        !insertmacro SahmProcessLog "recheck-result $SahmProcessResult"
        ${If} $SahmProcessResult > 0
        ${AndIf} $SahmProcessAttempts < 20
          IntOp $SahmProcessAttempts $SahmProcessAttempts + 1
          Sleep 250
          Goto sahm_process_recheck
        ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $SahmProcessResult != 0
    !insertmacro SahmProcessLog "check-failed"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(SahmProcessFailed)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro SahmProcessLog "check-complete"
!macroend
!endif
