use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
struct SessionToken(std::sync::Mutex<Option<String>>);

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Cette fenêtre n’a pas accès aux identifiants.".into())
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
async fn create_overlay(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    if window.app_handle().get_webview_window("overlay").is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        window.app_handle(),
        "overlay",
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
fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.dropmeme.desktop", "device")
        .map_err(|_| "Le gestionnaire d’identifiants Windows est inaccessible.".into())
}

#[tauri::command]
fn load_token(window: WebviewWindow) -> Result<Option<String>, String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    {
        match credential()?.get_password() {
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
        credential()?
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
        match credential()?.delete_credential() {
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_token,
            save_token,
            clear_token,
            create_overlay,
            create_placement
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Ouvrir DropMeme", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("DropMeme")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
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
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Impossible de démarrer DropMeme");
}
