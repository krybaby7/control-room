$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = 'Control Room — choose the Git repository to analyze'
$dialog.UseDescriptionForTitle = $true
$dialog.AutoUpgradeEnabled = $true
$owner = [System.Windows.Forms.Form]::new()
$owner.Text = 'Control Room folder selection'
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.StartPosition = 'CenterScreen'
$owner.Size = [System.Drawing.Size]::new(1,1)
try {
 $owner.Show()
 if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { @{status='selected';path=$dialog.SelectedPath} | ConvertTo-Json -Compress }
 else { @{status='cancelled'} | ConvertTo-Json -Compress }
} finally { $dialog.Dispose(); $owner.Dispose() }
