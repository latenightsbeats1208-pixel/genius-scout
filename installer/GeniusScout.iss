; ============================================================================
; Genius Scout — script Inno Setup 6
;
; Fichier en UTF-8 AVEC BOM (Inno Setup 6 Unicode) : les textes affichés à
; l'utilisateur portent leurs accents tels quels.
;
; Installation PAR UTILISATEUR (PrivilegesRequired=lowest) : aucune élévation
; administrateur, dans %LOCALAPPDATA%\Programs\GeniusScout.
;
; Les données utilisateur (base SQLite, clés API .env, profil Chrome dédié)
; vivent dans %USERPROFILE%\GeniusScoutData, en dehors du répertoire
; d'installation : la désinstallation les CONSERVE, toujours.
;
; Compilé par installer/build.mjs, qui passe la version et le chemin de la
; charge utile en paramètres :
;   ISCC.exe /DMyAppVersion=1.0.0 /DPayloadDir=...\dist\GeniusScout /DOutDir=... GeniusScout.iss
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef PayloadDir
  #define PayloadDir "dist\GeniusScout"
#endif
#ifndef OutDir
  #define OutDir "output"
#endif

#define MyAppName "Genius Scout"
#define MyAppPublisher "Genius Scout"
#define MyAppLauncher "GeniusScout.bat"
#define MyAppIcon "GeniusScout.ico"
#define MyDataDirName "GeniusScoutData"

[Setup]
AppId={{6F3B2A91-8C4D-4E75-9B10-2A7E5D3C1F48}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\GeniusScout
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=GeniusScout_Setup_{#MyAppVersion}
SetupIconFile={#PayloadDir}\{#MyAppIcon}
UninstallDisplayIcon={app}\{#MyAppIcon}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Un node.exe encore en cours (fenêtre du serveur ouverte) bloquerait le
; remplacement des fichiers : Inno propose de fermer l'application.
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Messages]
french.WelcomeLabel1=Bienvenue dans l'installation de [name]
french.WelcomeLabel2=[name/ver] va être installé sur votre ordinateur, pour votre compte utilisateur uniquement (aucun droit administrateur requis).%n%nGenius Scout scanne un album, extrait les crédits producteurs (Genius, Spotify, MusicBrainz, Discogs) et retrouve les comptes Instagram des producteurs.%n%nPrérequis : Google Chrome installé. Les clés API sont optionnelles et se renseignent après l'installation dans %USERPROFILE%\GeniusScoutData\.env.
french.FinishedHeadingLabel=Installation de [name] terminée
french.FinishedLabel=[name] est installé. Le raccourci « Genius Scout » lance le serveur local, ouvre un Chrome dédié (connectez-vous à Spotify et Instagram dedans) puis l'application dans votre navigateur.%n%nVos données seront enregistrées dans %USERPROFILE%\GeniusScoutData.

[CustomMessages]
french.DataKept=Vos données Genius Scout (base des scans, clés API, sessions Chrome) ont été conservées dans :%n%n%1%n%nSupprimez ce dossier à la main si vous souhaitez tout effacer.
french.LaunchAfterInstall=Lancer Genius Scout

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppIcon}"; Comment: "Scanner un album et retrouver les producteurs sur Instagram"
Name: "{group}\Lisez-moi Genius Scout"; Filename: "{app}\LISEZ-MOI.txt"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppIcon}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppLauncher}"; Description: "{cm:LaunchAfterInstall}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Uniquement les artefacts d'exécution écrits dans le répertoire d'installation.
Type: filesandordirs; Name: "{app}\app\.next\cache"
Type: dirifempty; Name: "{app}"

[Code]
function UserDataDir(): String;
begin
  Result := ExpandConstant('{%USERPROFILE}\{#MyDataDirName}');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // La désinstallation ne touche JAMAIS aux données : on le dit à l'utilisateur.
  if (CurUninstallStep = usPostUninstall) and DirExists(UserDataDir()) then
    SuppressibleMsgBox(
      FmtMessage(CustomMessage('DataKept'), [UserDataDir()]),
      mbInformation, MB_OK, IDOK);
end;
