use std::path::Path;

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use winapi::um::shellapi::ExtractIconExW;

/// Extract icon from a Windows .exe file and save it as PNG
/// Returns the path to the saved icon file
#[cfg(target_os = "windows")]
pub fn extract_icon(exe_path: &str, app_data_dir: &str) -> Result<String, String> {
    use image::{ImageBuffer, Rgba};
    use std::ptr::null_mut;
    use winapi::shared::windef::HICON;
    use winapi::um::wingdi::{GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
    use winapi::um::winuser::{DestroyIcon, GetIconInfo, ICONINFO};

    // Convert path to wide string
    let wide_path: Vec<u16> = std::ffi::OsStr::new(exe_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut large_icon: HICON = null_mut();
    let mut small_icon: HICON = null_mut();

    unsafe {
        // Extract large icon (index 0, get 1 icon)
        let result = ExtractIconExW(wide_path.as_ptr(), 0, &mut large_icon, &mut small_icon, 1);

        if result == 0 {
            return Err("Failed to extract icon from executable".to_string());
        }

        // Use large icon if available, otherwise small
        let icon_handle = if !large_icon.is_null() {
            large_icon
        } else if !small_icon.is_null() {
            small_icon
        } else {
            return Err("No icon found in executable".to_string());
        };

        // Get icon info
        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(icon_handle, &mut icon_info) == 0 {
            if !large_icon.is_null() {
                DestroyIcon(large_icon);
            }
            if !small_icon.is_null() {
                DestroyIcon(small_icon);
            }
            return Err("Failed to get icon info".to_string());
        }

        // For simplicity, we'll use a fixed size (32x32 or 48x48)
        // In production, you'd want to get the actual icon dimensions
        let icon_size = 48;

        // Create bitmap info structure
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = icon_size;
        bmi.bmiHeader.biHeight = -icon_size; // Negative for top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        // Get device context
        let hdc = winapi::um::winuser::GetDC(null_mut());
        if hdc.is_null() {
            if !large_icon.is_null() {
                DestroyIcon(large_icon);
            }
            if !small_icon.is_null() {
                DestroyIcon(small_icon);
            }
            return Err("Failed to get device context".to_string());
        }

        // Allocate buffer for bitmap data
        let buffer_size = (icon_size * icon_size * 4) as usize;
        let mut buffer: Vec<u8> = vec![0; buffer_size];

        // Get bitmap bits
        let result = GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            icon_size as u32,
            buffer.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        winapi::um::winuser::ReleaseDC(null_mut(), hdc);

        if result == 0 {
            if !large_icon.is_null() {
                DestroyIcon(large_icon);
            }
            if !small_icon.is_null() {
                DestroyIcon(small_icon);
            }
            return Err("Failed to get bitmap data".to_string());
        }

        // Convert BGRA to RGBA and create image
        let mut img_buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::new(icon_size as u32, icon_size as u32);

        for y in 0..icon_size {
            for x in 0..icon_size {
                let idx = ((y * icon_size + x) * 4) as usize;
                if idx + 3 < buffer.len() {
                    let b = buffer[idx];
                    let g = buffer[idx + 1];
                    let r = buffer[idx + 2];
                    let a = buffer[idx + 3];
                    img_buffer.put_pixel(x as u32, y as u32, Rgba([r, g, b, a]));
                }
            }
        }

        // Clean up icons
        if !large_icon.is_null() {
            DestroyIcon(large_icon);
        }
        if !small_icon.is_null() {
            DestroyIcon(small_icon);
        }

        // Generate filename from exe name
        let exe_name = Path::new(exe_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("icon");

        let icon_filename = format!("{}_icon.png", exe_name);
        let icon_path = Path::new(app_data_dir).join("icons").join(&icon_filename);

        // Create icons directory if it doesn't exist
        if let Some(parent) = icon_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        // Save as PNG
        img_buffer
            .save(&icon_path)
            .map_err(|e| format!("Failed to save icon: {}", e))?;

        Ok(icon_path.to_string_lossy().to_string())
    }
}

/// Fallback for non-Windows platforms
#[cfg(not(target_os = "windows"))]
pub fn extract_icon(_exe_path: &str, _app_data_dir: &str) -> Result<String, String> {
    Err("Icon extraction is only supported on Windows".to_string())
}
