# Windows Code Signing Guide for MemoryCard.cloud

To ensuring your users don't see "Unknown Publisher" warnings and to build trust, you should sign your Windows installers and executables.

## Prerequisites

1.  **Code Signing Certificate**: You must purchase a Standard or EV (Extended Validation) Code Signing Certificate from a trusted Certificate Authority (CA) such as:
    *   Sectigo
    *   DigiCert
    *   GlobalSign
2.  **Hardware Token (EV Only)**: If you buy an EV certificate, it will come on a USB hardware token.
3.  **Key Vault (Optional but Recommended)**: For automated builds (CI/CD), using Azure Key Vault or AWS CloudHSM is best.

## Configuration in Tauri

Tauri supports code signing out of the box. You need to provide the certificate information via environment variables or configuration.

### Method 1: Environment Variables (Recommended for Local/CI)

Set the following environment variables in your build environment (PowerShell or Bash):

**For PFX file (Standard Certificate):**
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="path/to/your/certificate.pfx"
$env:TAURI_SIGNING_PASSWORD="your-certificate-password"
```

**For Thumbprint (Windows Store / Hardware Token):**
If the certificate is installed in the Windows Certificate Store (Current User or Local Machine):
```powershell
$env:TAURI_SIGNING_CERTIFICATE_THUMBPRINT="e42d76..."
```

### Method 2: tauri.conf.json

You can technically add these to `tauri.conf.json` but it is **highly discouraged** to commit secrets to git.

## Signing the Separate Builds

Our `scripts/build-localized.ps1` script simply calls `npm run tauri build`. To sign the builds, you just need to ensure the environment variables are set **before** running the script.

```powershell
# 1. Set up signing variables
$env:TAURI_SIGNING_PRIVATE_KEY="C:\certs\my-cert.pfx"
$env:TAURI_SIGNING_PASSWORD="secure-password"

# 2. Run the localized build script
.\scripts\build-localized.ps1
```

## Verifying the Signature

After building, inspect the generated `.exe` or `.msi`:
1.  Right-click the file -> **Properties**.
2.  Go to the **Digital Signatures** tab.
3.  You should see "Unrender" (or your entity name) listed.

## Troubleshooting

-   **"SignTool Error: No certificates were found that met all the given criteria."**
    -   Ensure the certificate is installed or the path to the PFX is correct.
    -   Check if the certificate has expired.
-   **Password issues:** Ensure special characters in the password are escaped if setting via command line.
