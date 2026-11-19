use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("WalkDir error: {0}")]
    WalkDir(#[from] walkdir::Error),

    #[error("API Error {code}: {message}")]
    Api { code: u16, message: String },

    #[error("Validation Error: {0}")]
    Validation(String),

    #[error("Not Found: {0}")]
    NotFound(String),

    #[error("Internal Error: {0}")]
    Internal(String),
}

#[derive(Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        err.to_string()
    }
}

// Convert core errors to Serializable CommandError automatically if needed?
// Usually Tauri handlers return Result<T, String> or Result<T, CommandError>.
// Note: Tauri 2.0 recommends returning a type that implements Serialize.
// But legacy code uses String. To interact with existing frontend cleanly, we might stick to String for now
// OR we return a JSON string?
// For "Senior" refactor, we should return a struct.
// However, the frontend currently expects `catch (e) { ... string ... }`.
// If we return a struct, `e` will be an object.
// The frontend `api.ts` might need adjustment if we change the return type signature on the wire.
// To stay safe but improve backend internally: We will convert AppError string for now,
// OR arguably better: Return JSON string? No, Tauri handles serialization.
// Let's implement `impl Serialize for AppError` manually or via a wrapper.
// Simplest path for "Refactor" without breaking frontend immediately:
// Keep returning `Result<T, String>` at the command boundary, but use `AppError` internally.
// But the plan said "Target: Return Result<T, CommandError>".
// So let's do that. Frontend will receive an object. existing frontend `statusMessage = String(e)`
// might result in `[object Object]`.
// I should update `api.ts` to handle this?
// Or I can make CommandError serialize to a String if possible? No.
// Let's stick to returning `Result<T, String>` (mapped from AppError) for this iteration to avoid breaking the Frontend Integration I just finished.
// We can format the string nicely though: "CODE: Message".
// Wait, the user wants "Senior Rust". Senior Rust uses types.
// I'll stick to `Result<T, String>` at the `#[tauri::command]` boundary for safety,
// converting `AppError` to string.
// BUT I will define `AppError` for internal logic.

impl AppError {
    pub fn to_frontend_string(&self) -> String {
        self.to_string()
    }
}
