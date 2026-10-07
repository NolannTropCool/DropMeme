use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{
    ipc::{Channel, InvokeBody, Request, Response},
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
struct SessionToken(Mutex<Option<String>>);

/// Main's end of the quick-send relay.
#[derive(Default)]
struct QuickSendRelay(Mutex<Option<Channel<serde_json::Value>>>);

/// A quick-send file waiting for main, keyed by its request id. One slot: a new file replaces the previous one.
#[derive(Default)]
struct StagedFile(Mutex<Option<(String, Vec<u8>)>>);
const STAGED_MAX: usize = 64 * 1024 * 1024;
const STAGED_TTL: Duration = Duration::from_secs(120);
const FAVORITE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm"];

fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// `<uuid>.<ext>` named by main: never a path, so nothing outside the favorites folder can be reached.
fn is_favorite_file(file: &str) -> bool {
    file.split_once('.')
        .is_some_and(|(id, ext)| is_uuid(id) && FAVORITE_EXTENSIONS.contains(&ext))
}

fn favorite_path<R: Runtime>(app: &AppHandle<R>, file: &str) -> Result<PathBuf, String> {
    if !is_favorite_file(file) {
        return Err("Favori invalide.".into());
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("favorites").join(file))
        .map_err(|_| "Dossier des favoris inaccessible.".into())
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Cette fenêtre n’a pas accès aux identifiants.".into())
    }
}

fn require_quick_send(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "quick-send" {
        Ok(())
    } else {
        Err("Cette fenêtre ne peut pas envoyer.".into())
    }
}

#[tauri::command]
fn quick_send_listen(
    window: WebviewWindow,
    channel: Channel<serde_json::Value>,
    relay: State<'_, QuickSendRelay>,
) -> Result<(), String> {
    require_main(&window)?;
    *relay.0.lock().map_err(|_| "Relais indisponible.")? = Some(channel);
    Ok(())
}

// Events carry no sender, so any webview could forge one. A channel only reaches main, and only quick-send may feed it.
#[tauri::command]
fn quick_send(
    window: WebviewWindow,
    request: serde_json::Value,
    relay: State<'_, QuickSendRelay>,
) -> Result<(), String> {
    require_quick_send(&window)?;
    let relay = relay.0.lock().map_err(|_| "Relais indisponible.")?;
    relay
        .as_ref()
        .ok_or("DropMeme ne répond pas.")?
        .send(request)
        .map_err(|_| "DropMeme ne répond pas.".into())
}

// Raw IPC body: a 25 MB file serialized as a JSON event would be several times larger.
#[tauri::command]
fn stage_file(
    window: WebviewWindow,
    request: Request<'_>,
    staged: State<'_, StagedFile>,
) -> Result<(), String> {
    require_quick_send(&window)?;
    let id = request
        .headers()
        .get("x-request-id")
        .and_then(|id| id.to_str().ok())
        .filter(|id| is_uuid(id))
        .ok_or("Fichier invalide.")?
        .to_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Fichier invalide.".into());
    };
    if bytes.len() > STAGED_MAX {
        return Err("Fichier trop volumineux (64 Mo maximum).".into());
    }
    stage(window.app_handle(), &staged, id, bytes.clone())
}

/// Sends a favorite file through the same slot as a dropped one: its bytes never visit the quick-send webview.
#[tauri::command]
async fn stage_favorite(
    window: WebviewWindow,
    id: String,
    file: String,
    staged: State<'_, StagedFile>,
) -> Result<(), String> {
    require_quick_send(&window)?;
    if !is_uuid(&id) {
        return Err("Fichier invalide.".into());
    }
    let bytes = std::fs::read(favorite_path(window.app_handle(), &file)?)
        .map_err(|_| "Ce favori est introuvable. Supprimez-le depuis l’onglet Favoris.")?;
    stage(window.app_handle(), &staged, id, bytes)
}

fn stage(app: &AppHandle, staged: &StagedFile, id: String, bytes: Vec<u8>) -> Result<(), String> {
    *staged.0.lock().map_err(|_| "Fichier indisponible.")? = Some((id.clone(), bytes));
    // Main normally claims it within milliseconds; never keep an unclaimed file in memory.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(STAGED_TTL);
        if let Ok(mut slot) = app.state::<StagedFile>().0.lock() {
            if slot.as_ref().is_some_and(|(staged, _)| *staged == id) {
                *slot = None;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn take_file(
    window: WebviewWindow,
    id: String,
    staged: State<'_, StagedFile>,
) -> Result<Response, String> {
    require_main(&window)?;
    match staged.0.lock().map_err(|_| "Fichier indisponible.")?.take() {
        Some((staged, bytes)) if staged == id => Ok(Response::new(bytes)),
        _ => Err("Le fichier n’est plus disponible. Déposez-le à nouveau.".into()),
    }
}

// Main alone decides what is kept: the list, its caps and the name of every file.
#[tauri::command]
async fn favorite_write(window: WebviewWindow, request: Request<'_>) -> Result<(), String> {
    require_main(&window)?;
    let file = request
        .headers()
        .get("x-favorite")
        .and_then(|file| file.to_str().ok())
        .ok_or("Favori invalide.")?;
    let path = favorite_path(window.app_handle(), file)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Favori invalide.".into());
    };
    if bytes.is_empty() || bytes.len() > STAGED_MAX {
        return Err("Fichier vide ou trop volumineux (64 Mo maximum).".into());
    }
    path.parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, bytes))
        .map_err(|_| "Enregistrement du favori impossible.".into())
}

// Previews as raw bytes for an object URL: no asset protocol scope to open for every webview.
#[tauri::command]
async fn favorite_read(window: WebviewWindow, file: String) -> Result<Response, String> {
    if !matches!(window.label(), "main" | "quick-send") {
        return Err("Cette fenêtre n’a pas accès aux favoris.".into());
    }
    std::fs::read(favorite_path(window.app_handle(), &file)?)
        .map(Response::new)
        .map_err(|_| "Ce favori est introuvable.".into())
}

#[tauri::command]
fn favorite_delete(window: WebviewWindow, file: String) -> Result<(), String> {
    require_main(&window)?;
    match std::fs::remove_file(favorite_path(window.app_handle(), &file)?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err("Suppression du fichier impossible.".into())
        }
        _ => Ok(()),
    }
}

// WebView2 deadlocks when a webview is built from a synchronous IPC command.
#[tauri::command]
async fn create_placement(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    if window
        .app_handle()
        .get_webview_window("placement")
        .is_some()
    {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        window.app_handle(),
        "placement",
        WebviewUrl::App("placement.html".into()),
    )
    .title("DropMeme · Placer la zone")
    .inner_size(480.0, 320.0)
    .min_inner_size(160.0, 120.0)
    .max_inner_size(8192.0, 4320.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .visible(false);
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args("--autoplay-policy=no-user-gesture-required");
    builder
        .build()
        .map(|_| ())
        .map_err(|_| "Création du cadre de placement impossible.".into())
}

#[tauri::command]
async fn create_overlay(window: WebviewWindow, label: Option<String>) -> Result<(), String> {
    require_main(&window)?;
    let label = label.unwrap_or_else(|| "overlay".into());
    if label != "overlay"
        && !label
            .strip_prefix("overlay-")
            .and_then(|index| index.parse::<u8>().ok())
            .is_some_and(|index| (1..8).contains(&index))
    {
        return Err("Superposition invalide.".into());
    }
    if window.app_handle().get_webview_window(&label).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        window.app_handle(),
        &label,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("DropMeme · Média")
    .inner_size(480.0, 320.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .focused(false)
    .focusable(false)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false);
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args("--autoplay-policy=no-user-gesture-required");
    builder
        .build()
        .map(|_| ())
        .map_err(|_| "Création de la superposition impossible.".into())
}

#[cfg(target_os = "windows")]
fn credential(window: &WebviewWindow) -> Result<keyring::Entry, String> {
    // Keyed by identifier so the dev build never touches the installed app's token.
    keyring::Entry::new(&window.config().identifier, "device")
        .map_err(|_| "Le gestionnaire d’identifiants Windows est inaccessible.".into())
}

#[tauri::command]
fn load_token(window: WebviewWindow) -> Result<Option<String>, String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    {
        match credential(&window)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Lecture sécurisée des identifiants impossible.".into()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        window
            .state::<SessionToken>()
            .0
            .lock()
            .map(|token| token.clone())
            .map_err(|_| "Lecture de la session impossible.".into())
    }
}

#[tauri::command]
fn save_token(window: WebviewWindow, token: String) -> Result<(), String> {
    require_main(&window)?;
    if token.len() < 32 || token.len() > 128 || !token.is_ascii() {
        return Err("Jeton invalide.".into());
    }
    #[cfg(target_os = "windows")]
    {
        credential(&window)?
            .set_password(&token)
            .map_err(|_| "Enregistrement sécurisé impossible.".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        *window
            .state::<SessionToken>()
            .0
            .lock()
            .map_err(|_| "Enregistrement de la session impossible.")? = Some(token);
        Ok(())
    }
}

#[tauri::command]
fn clear_token(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    {
        match credential(&window)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Suppression sécurisée impossible.".into()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        *window
            .state::<SessionToken>()
            .0
            .lock()
            .map_err(|_| "Suppression de la session impossible.")? = None;
        Ok(())
    }
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, update: Option<&str>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Ouvrir DropMeme", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    if let Some(version) = update {
        let label = format!("Mettre à jour vers {version}");
        menu.prepend(&MenuItem::with_id(app, "update", label, true, None::<&str>)?)?;
    }
    Ok(menu)
}

#[tauri::command]
fn announce_update(window: WebviewWindow, version: String) -> Result<(), String> {
    require_main(&window)?;
    let valid = version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c));
    if version.is_empty() || version.len() > 32 || !valid {
        return Err("Version invalide.".into());
    }
    let app = window.app_handle();
    let tray = app.tray_by_id("main").ok_or("Zone de notification indisponible.")?;
    tray_menu(app, Some(&version))
        .and_then(|menu| tray.set_menu(Some(menu)))
        .map_err(|_| "Mise à jour du menu impossible.".into())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "windows"))]
    let builder = builder.manage(SessionToken::default());
    builder
        .manage(QuickSendRelay::default())
        .manage(StagedFile::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_token,
            save_token,
            clear_token,
            create_overlay,
            create_placement,
            announce_update,
            quick_send_listen,
            quick_send,
            stage_file,
            take_file,
            stage_favorite,
            favorite_write,
            favorite_read,
            favorite_delete
        ])
        .setup(|app| {
            let menu = tray_menu(app.handle(), None)?;
            let name = app.package_info().name.clone();
            if let Some(main) = app.get_webview_window("main") {
                main.set_title(&name)?;
            }
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip(&name)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "update" => {
                        show_main(app);
                        let _ = app.emit_to("main", "tray-update", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Both stay alive hidden: main relays quick-send requests, quick-send must open instantly.
            // Quick-send hides itself on focus loss, sparing its file dialog and drags from other windows.
            if let ("main" | "quick-send", WindowEvent::CloseRequested { api, .. }) =
                (window.label(), event)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Impossible de démarrer DropMeme");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorite_files_are_a_uuid_and_a_known_extension() {
        let id = "0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10";
        for ext in FAVORITE_EXTENSIONS {
            assert!(is_favorite_file(&format!("{id}.{ext}")));
        }
        for file in [
            "",
            id,
            "0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10.mov",
            "0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10.PNG",
            "0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10.png.exe",
            "0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a1.png",
            "0b6f3f9e2d4c-4f53-9a51-6f4f0c3b8a10-.png",
            "0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a1g.png",
            "../0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8.png",
            "..\\0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10.png",
            "C:0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a1.png",
        ] {
            assert!(!is_favorite_file(file), "{file}");
        }
    }
}
