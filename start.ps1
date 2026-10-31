$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Host 'Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org/ and start again.' -ForegroundColor Red
    exit 1
}
& $nodeCommand.Source --input-type=module -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))process.exit(1);try{await import('node:sqlite')}catch{process.exit(1)}" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Node.js 22.13 or newer with built-in SQLite is required. Download: https://nodejs.org/' -ForegroundColor Red
    exit 1
}
if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
if (-not $env:PORT) { $env:PORT = '8765' }
$serverPort = 0
if (-not [int]::TryParse($env:PORT, [ref]$serverPort) -or $serverPort -lt 1 -or $serverPort -gt 65535) {
    Write-Host 'PORT must be a number from 1 to 65535.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'server.mjs'))) {
    Write-Host 'server.mjs is missing. Keep the launcher inside the full application folder.' -ForegroundColor Red
    exit 1
}
# Check the requested binding without reusing or stopping an existing service.
& $nodeCommand.Source --input-type=module -e "import net from 'node:net';const s=net.createServer();s.once('error',e=>{console.error(e.message);process.exitCode=1});s.listen({host:process.env.HOST,port:Number(process.env.PORT),exclusive:true},()=>s.close());"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'The address/port is unavailable. Close the other server or set a different PORT. No existing process was stopped.' -ForegroundColor Red
    exit 1
}
$browserHost = if ($env:HOST -eq '::1') { '[::1]' } elseif ($env:HOST -eq '::' -or $env:HOST -eq '0.0.0.0') { '127.0.0.1' } else { $env:HOST }
$applicationUrl = 'http://' + $browserHost + ':' + $serverPort
$serverProcess = $null
$launcherExitCode = 0
try {
    Write-Host ('Starting Council at ' + $applicationUrl)
    Write-Host 'Keep this window open. Press Ctrl+C to stop this server.'
    $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList 'server.mjs' -WorkingDirectory $projectDirectory -NoNewWindow -PassThru
    $isReady = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($serverProcess.HasExited) { break }
        try {
            $response = Invoke-WebRequest -Uri ($applicationUrl + '/api/bootstrap') -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $isReady = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (-not $isReady) { throw 'Server did not become ready. See its error output above.' }
    try { Start-Process $applicationUrl } catch { Write-Host ('Open this address in your browser: ' + $applicationUrl) }
    $serverProcess.WaitForExit()
    $launcherExitCode = $serverProcess.ExitCode
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $launcherExitCode = 1
} finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        # Only the process created by this invocation is stopped.
        Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue
    }
}
exit $launcherExitCode
