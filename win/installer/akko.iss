; One-click installer for Akko on Windows: no questions, installs for the current user (no admin), adds Start
; menu and desktop shortcuts, installs WebView2 if this PC doesn't have it yet, and starts Akko.
; Build: ISCC /DAppVersion=0.2.0 installer\akko.iss   (after cargo build --release)

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B1E4C2A-9D3F-4A57-8E21-4B0A11C0FFEE}
AppName=Akko
AppVersion={#AppVersion}
AppVerName=Akko {#AppVersion}
AppPublisher=yahyagazizuly
AppPublisherURL=https://github.com/yahyagazizuly/akko
DefaultDirName={localappdata}\Programs\Akko
PrivilegesRequired=lowest
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
CloseApplications=force
RestartApplications=no
OutputDir=..\target\installer
OutputBaseFilename=Akko-Setup
SetupIconFile=..\assets\akko.ico
UninstallDisplayIcon={app}\Akko.exe
UninstallDisplayName=Akko
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible

[Files]
Source: "..\target\release\akko.exe"; DestDir: "{app}"; DestName: "Akko.exe"; Flags: ignoreversion
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
Name: "{userprograms}\Akko"; Filename: "{app}\Akko.exe"
Name: "{userdesktop}\Akko"; Filename: "{app}\Akko.exe"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft WebView2…"; Check: NeedsWebView2; Flags: waituntilterminated
Filename: "{app}\Akko.exe"; Flags: nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM Akko.exe /F"; Flags: runhidden; RunOnceId: "StopAkko"

[Registry]
; Launch at login is switched on from Akko's settings; uninstalling removes it.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "Akko"; Flags: uninsdeletevalue dontcreatekey

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\Akko"

[Code]
const
  WebView2Id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2(Root: Integer; Key: String): Boolean;
var
  V: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0');
end;

function NeedsWebView2: Boolean;
begin
  Result := not (HasWebView2(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2Id)
    or HasWebView2(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2Id)
    or HasWebView2(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2Id));
end;
