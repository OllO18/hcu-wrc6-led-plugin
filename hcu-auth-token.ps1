<#
.SYNOPSIS
  Besorgt und bestaetigt einen Connect-API Auth-Token fuer die Homematic IP HCU.

.BESCHREIBUNG
  Fuehrt die zwei Schritte aus Kapitel "2.4 Get an authorization token" der
  offiziellen Connect-API-Dokumentation aus:
    1. requestConnectApiAuthToken
    2. confirmConnectApiAuthToken
  und speichert den bestaetigten Token in authtoken.txt im aktuellen
  Verzeichnis.

.VERWENDUNG
  Als Datei ausfuehren (NICHT den Inhalt in die Konsole einfuegen!):

    powershell -ExecutionPolicy Bypass -File .\hcu-auth-token.ps1 -HcuAddress "192.168.1.50"

  Der Aktivierungsschluessel wird interaktiv abgefragt, wenn er nicht als
  Parameter uebergeben wird.
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$HcuAddress,

  [string]$PluginId = "io.github.ollo18.wrc6led",

  [string]$ActivationKey
)

$ErrorActionPreference = "Stop"

# --- Zertifikatspruefung fuer das selbstsignierte HCU-Zertifikat umgehen ---
$skipCert = @{}
if ($PSVersionTable.PSVersion.Major -ge 6) {
  $skipCert = @{ SkipCertificateCheck = $true }
} else {
  if (-not ("TrustAllCertsPolicy" -as [type])) {
    Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) {
        return true;
    }
}
"@
  }
  [System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
}

if (-not $ActivationKey) {
  $ActivationKey = Read-Host "Aktivierungsschluessel aus HCUweb (Entwicklermodus-Seite) eingeben"
}

$baseUrl = "https://$HcuAddress`:6969/hmip/auth"
$headers = @{ "VERSION" = "12"; "Content-Type" = "application/json" }

Write-Host "Fordere Auth-Token an ..." -ForegroundColor Cyan

$requestBody = @{
  activationKey = $ActivationKey
  pluginId      = $PluginId
  friendlyName  = @{ en = "WRC6 LED Control"; de = "WRC6 LED-Steuerung" }
} | ConvertTo-Json

$requestResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/requestConnectApiAuthToken" `
  -Headers $headers -Body $requestBody @skipCert

$authToken = $requestResponse.authToken
if (-not $authToken) {
  Write-Error "Kein authToken in der Antwort erhalten: $($requestResponse | ConvertTo-Json)"
  exit 1
}
Write-Host "Auth-Token erhalten: $authToken" -ForegroundColor Green

Write-Host "Bestaetige Auth-Token ..." -ForegroundColor Cyan

$confirmBody = @{
  activationKey = $ActivationKey
  authToken     = $authToken
} | ConvertTo-Json

$confirmResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/confirmConnectApiAuthToken" `
  -Headers $headers -Body $confirmBody @skipCert

Write-Host "Bestaetigt. Client-ID: $($confirmResponse.clientId)" -ForegroundColor Green

$authToken | Out-File -FilePath ".\authtoken.txt" -Encoding ascii -NoNewline
Write-Host "Token wurde in authtoken.txt gespeichert (im aktuellen Verzeichnis)." -ForegroundColor Green
